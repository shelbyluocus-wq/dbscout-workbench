<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  History,
  Info,
  KeyRound,
  RefreshCw,
  Search,
  Table2,
  X,
} from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { filterRevisionItems, normalizeCellDisplay, parseAuditTimestampMs } from "../utils/tableChangeHistory.js";
import { splitSearchHighlight } from "../utils/tableHistorySnapshot.js";
import { useTableChangeHistory } from "../composables/useTableChangeHistory.js";
import { invokeWorkbench as defaultInvokeWorkbench } from "../utils/tauriBridge.js";

const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 44;
const BUFFER_ROWS = 12;
const ROW_NUM_WIDTH = 44;
const MIN_COL_WIDTH = 76;
const MAX_COL_WIDTH = 460;

const props = defineProps({
  connectionId: { type: String, default: "" },
  database: { type: String, default: "" },
  tableName: { type: String, default: "" },
  tableComment: { type: String, default: "" },
  tableMeta: { type: Object, default: null },
  invokeWorkbench: { type: Function, default: null },
  isLoggedIn: { type: Boolean, default: false },
  canOpenBackupCenter: { type: Boolean, default: true },
});

const emit = defineEmits(["switch-view", "open-backup-center"]);

const history = useTableChangeHistory({
  invokeWorkbench: (...args) => (props.invokeWorkbench || defaultInvokeWorkbench)(...args),
  isLoggedIn: () => Boolean(props.isLoggedIn),
  getSelfLabel: () => t("home.modifiedSelf"),
});

const rootRef = ref(null);
const splitStageRef = ref(null);
const beforeScrollerRef = ref(null);
const afterScrollerRef = ref(null);
const searchInputRef = ref(null);

const scrollTop = ref(0);
const viewportHeight = ref(520);
const splitRatio = ref(0.5);
const draggingSplitter = ref(false);
const columnWidths = ref({});
const resizingCol = ref(null);

let syncSourceSide = "";
let syncReleaseFrame = 0;
let resizeObserver = null;

const state = history.state;
const snapshot = history.snapshot;
const displayRows = history.displayRows;
const changedDisplayIndices = history.changedDisplayIndices;
const searchResult = history.searchResult;
const activeSearchMatch = history.activeSearchMatch;
const selectedRevision = history.selectedRevision;
const filteredRevisions = history.filteredRevisions;
const actors = history.actors;
const externalNotice = history.externalNotice;
const columnComments = history.columnComments;

const isFullTableMode = computed(() => snapshot.value.mode === "full-table");
const isFieldDiffMode = computed(() => snapshot.value.mode === "field-diff");
const isInitialLoading = computed(() => (
  (state.loading || state.liveLoading) && state.revisions.length === 0
));

const fullTableColumns = computed(() => snapshot.value.columns || []);

function estimateDisplayChars(text) {
  const s = String(text || "");
  let units = 0;
  for (let i = 0; i < s.length && i < 40; i += 1) {
    const code = s.charCodeAt(i);
    units += code >= 0x2e80 ? 1.85 : 1;
  }
  return units;
}

// Estimate comfortable default column widths from headers + first 40 rows (CJK-aware).
const computedDefaultWidths = computed(() => {
  const cols = fullTableColumns.value;
  const sampleRows = displayRows.value.slice(0, 40);
  const widths = {};
  for (const col of cols) {
    let maxUnits = Math.max(
      estimateDisplayChars(col.name),
      estimateDisplayChars(col.comment) * 0.92,
    );
    for (const row of sampleRows) {
      const bText = row.before && Object.hasOwn(row.before, col.name)
        ? normalizeCellDisplay(row.before[col.name]).text
        : "";
      const aText = row.after && Object.hasOwn(row.after, col.name)
        ? normalizeCellDisplay(row.after[col.name]).text
        : "";
      maxUnits = Math.max(maxUnits, estimateDisplayChars(bText), estimateDisplayChars(aText));
    }
    const base = col.primaryKey ? 84 : 108;
    const est = Math.round(maxUnits * 8.2 + 28);
    widths[col.name] = Math.max(base, Math.min(280, est));
  }
  return widths;
});

function widthForCol(colName) {
  const custom = columnWidths.value[colName];
  if (Number.isFinite(custom)) {
    return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, custom));
  }
  return computedDefaultWidths.value[colName] || 120;
}

const gridTemplateColumns = computed(() => {
  const tracks = fullTableColumns.value.map((col) => `${widthForCol(col.name)}px`);
  return `${ROW_NUM_WIDTH}px ${tracks.join(" ")}`;
});

const gridTotalWidth = computed(() => {
  const sum = fullTableColumns.value.reduce((acc, col) => acc + widthForCol(col.name), ROW_NUM_WIDTH);
  return `${sum}px`;
});

const totalHeight = computed(() => displayRows.value.length * ROW_HEIGHT);

const visibleRange = computed(() => {
  const total = displayRows.value.length;
  if (!total) return { start: 0, end: 0 };
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - BUFFER_ROWS);
  const count = Math.ceil(Math.max(240, viewportHeight.value) / ROW_HEIGHT) + BUFFER_ROWS * 2;
  return { start, end: Math.min(total, start + count) };
});

const visibleRows = computed(() => (
  displayRows.value.slice(visibleRange.value.start, visibleRange.value.end).map((row, offset) => ({
    row,
    displayIndex: visibleRange.value.start + offset,
  }))
));

const splitStageStyle = computed(() => ({
  gridTemplateColumns: `minmax(0, ${splitRatio.value}fr) 5px minmax(0, ${1 - splitRatio.value}fr)`,
}));

// Fallback field-diff items (when full-table snapshot cannot be reconstructed)
const filteredFallbackItems = computed(() => {
  if (!selectedRevision.value || !isFieldDiffMode.value) return [];
  return filterRevisionItems(
    selectedRevision.value.items,
    state.searchQuery,
    columnComments.value,
  );
});

const activeChangeDisplay = computed(() => {
  const total = changedDisplayIndices.value.length;
  if (!total) return null;
  const idx = ((state.activeChangeIndex % total) + total) % total;
  return { current: idx + 1, total };
});

const searchMatchDisplay = computed(() => {
  const q = String(state.searchQuery || "").trim();
  if (!q) return null;
  if (isFullTableMode.value) {
    const total = searchResult.value.matches.length;
    const current = total > 0 ? (((state.activeMatchIndex % total) + total) % total) + 1 : 0;
    return { current, total };
  }
  if (isFieldDiffMode.value) {
    const total = filteredFallbackItems.value.length;
    return { current: total, total, filterMode: true };
  }
  return null;
});

const fallbackBannerText = computed(() => {
  if (!isFieldDiffMode.value) return "";
  switch (snapshot.value.reason) {
    case "missing-row-identity":
      return t("tableHistory.fallback.missingRowIdentity");
    case "no-primary-key":
      return t("tableHistory.fallback.noPrimaryKey");
    case "ddl-only":
      return t("tableHistory.fallback.ddlOnly");
    case "live-load-failed":
      return t("tableHistory.fallback.liveLoadFailed");
    default:
      return t("tableHistory.fallback.generic");
  }
});

// Always-on locked vertical + horizontal synchronized scrolling between Before & After panes
function onGridScroll(side, event) {
  const source = event?.currentTarget;
  if (!source) return;
  if (syncSourceSide && syncSourceSide !== side) return;

  syncSourceSide = side;
  const top = source.scrollTop;
  const left = source.scrollLeft;
  scrollTop.value = top;
  if (source.clientHeight) {
    viewportHeight.value = source.clientHeight;
  }

  const peer = side === "before" ? afterScrollerRef.value : beforeScrollerRef.value;
  if (peer) {
    if (peer.scrollTop !== top) peer.scrollTop = top;
    if (peer.scrollLeft !== left) peer.scrollLeft = left;
  }

  if (syncReleaseFrame) cancelAnimationFrame(syncReleaseFrame);
  syncReleaseFrame = requestAnimationFrame(() => {
    syncSourceSide = "";
    syncReleaseFrame = 0;
  });
}

function scrollBothPanesTo(targetTop, targetLeft = null) {
  const beforeEl = beforeScrollerRef.value;
  const afterEl = afterScrollerRef.value;
  const clampedTop = Math.max(0, Math.round(targetTop));
  syncSourceSide = "programmatic";
  scrollTop.value = clampedTop;
  if (beforeEl) {
    beforeEl.scrollTop = clampedTop;
    if (targetLeft !== null) beforeEl.scrollLeft = Math.max(0, Math.round(targetLeft));
  }
  if (afterEl) {
    afterEl.scrollTop = clampedTop;
    if (targetLeft !== null) afterEl.scrollLeft = Math.max(0, Math.round(targetLeft));
  }
  if (syncReleaseFrame) cancelAnimationFrame(syncReleaseFrame);
  syncReleaseFrame = requestAnimationFrame(() => {
    syncSourceSide = "";
    syncReleaseFrame = 0;
  });
}

function columnLeftOffset(colName) {
  let left = ROW_NUM_WIDTH;
  for (const col of fullTableColumns.value) {
    if (col.name === colName) {
      return { left, width: widthForCol(col.name) };
    }
    left += widthForCol(col.name);
  }
  return null;
}

function scrollToDisplayRow(displayIndex, colName = "") {
  if (displayIndex < 0 || displayIndex >= displayRows.value.length) return;
  const scroller = beforeScrollerRef.value || afterScrollerRef.value;
  const availHeight = Math.max(120, (scroller?.clientHeight || viewportHeight.value) - HEADER_HEIGHT);
  const rowTop = displayIndex * ROW_HEIGHT;
  const targetTop = Math.max(0, rowTop - Math.round(availHeight * 0.32));

  let targetLeft = null;
  if (colName && scroller) {
    const pos = columnLeftOffset(colName);
    if (pos) {
      const viewLeft = scroller.scrollLeft;
      const viewRight = viewLeft + scroller.clientWidth;
      if (pos.left < viewLeft + 24 || pos.left + pos.width > viewRight - 16) {
        targetLeft = Math.max(0, pos.left - Math.round(scroller.clientWidth * 0.25));
      }
    }
  }
  scrollBothPanesTo(targetTop, targetLeft);
}

function jumpToFirstChangedRow() {
  if (!isFullTableMode.value) return;
  const firstIdx = changedDisplayIndices.value[0];
  if (firstIdx === undefined) {
    scrollBothPanesTo(0, 0);
    return;
  }
  const row = displayRows.value[firstIdx];
  const firstCol = row?.changedCols?.[0] || "";
  scrollToDisplayRow(firstIdx, firstCol);
}

function handleStepChange(delta) {
  const displayIndex = history.stepChange(delta);
  if (displayIndex < 0) return;
  const row = displayRows.value[displayIndex];
  scrollToDisplayRow(displayIndex, row?.changedCols?.[0] || "");
}

function handleStepSearchMatch(delta) {
  const match = history.stepSearchMatch(delta);
  if (!match) return;
  scrollToDisplayRow(match.displayIndex, match.colName);
}

function handleSearchKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    handleStepSearchMatch(event.shiftKey ? -1 : 1);
  } else if (event.key === "Escape" && state.searchQuery) {
    event.preventDefault();
    history.setSearchQuery("");
  }
}

function handleViewKeydown(event) {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === "f") {
    event.preventDefault();
    searchInputRef.value?.focus?.();
    searchInputRef.value?.select?.();
  }
}

// Draggable center splitter
function beginSplitterDrag(event) {
  if (event.button !== 0) return;
  draggingSplitter.value = true;
  event.preventDefault();
  window.addEventListener("pointermove", moveSplitter);
  window.addEventListener("pointerup", endSplitterDrag, { once: true });
  window.addEventListener("pointercancel", endSplitterDrag, { once: true });
}

function moveSplitter(event) {
  const stage = splitStageRef.value;
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  if (rect.width <= 0) return;
  const raw = (event.clientX - rect.left) / rect.width;
  splitRatio.value = Math.max(0.26, Math.min(0.74, raw));
}

function endSplitterDrag() {
  draggingSplitter.value = false;
  window.removeEventListener("pointermove", moveSplitter);
  window.removeEventListener("pointerup", endSplitterDrag);
  window.removeEventListener("pointercancel", endSplitterDrag);
}

function resetSplitter() {
  splitRatio.value = 0.5;
}

// Synchronized column resizing (resizing on either pane updates both panes)
function beginColResize(colName, event) {
  if (event.button !== 0) return;
  event.stopPropagation();
  event.preventDefault();
  resizingCol.value = {
    colName,
    startX: event.clientX,
    startWidth: widthForCol(colName),
  };
  window.addEventListener("pointermove", moveColResize);
  window.addEventListener("pointerup", endColResize, { once: true });
  window.addEventListener("pointercancel", endColResize, { once: true });
}

function moveColResize(event) {
  const drag = resizingCol.value;
  if (!drag) return;
  const next = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(drag.startWidth + event.clientX - drag.startX)));
  columnWidths.value = { ...columnWidths.value, [drag.colName]: next };
}

function endColResize() {
  resizingCol.value = null;
  window.removeEventListener("pointermove", moveColResize);
  window.removeEventListener("pointerup", endColResize);
  window.removeEventListener("pointercancel", endColResize);
}

function resetColWidth(colName) {
  const copy = { ...columnWidths.value };
  delete copy[colName];
  columnWidths.value = copy;
}

// Formatting helpers
function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatAuditTimestamp(ts) {
  const ms = parseAuditTimestampMs(ts);
  if (!ms) return String(ts || "").trim();
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function isRollbackEntry(item) {
  return Boolean(item?.isRollback);
}

function actorInitial(name) {
  const text = String(name || "").trim();
  if (!text) return "?";
  return Array.from(text)[0].toUpperCase();
}

function sourceLabel(source, isRollback) {
  if (isRollback) return t("tableHistory.source.rollback");
  switch (String(source || "")) {
    case "grid":
      return t("tableHistory.source.grid");
    case "import":
      return t("tableHistory.source.import");
    case "ddl":
      return t("tableHistory.source.ddl");
    case "agent":
      return t("tableHistory.source.agent");
    case "sql_console":
      return t("tableHistory.source.sql_console");
    default:
      return t("tableHistory.source.other");
  }
}

function shortTime(ts) {
  const full = formatAuditTimestamp(ts);
  if (!full) return "";
  return /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(full) ? full.slice(5, 16) : full;
}

function fullTime(ts) {
  return formatAuditTimestamp(ts) || String(ts || "");
}

function fieldComment(field) {
  if (!field) return "";
  return columnComments.value.get(String(field).toLowerCase()) || "";
}

function cellDisplay(rowObj, colName) {
  if (!rowObj || !Object.hasOwn(rowObj, colName)) {
    return { text: "—", isNull: false, isEmpty: false, isMissing: true };
  }
  return { ...normalizeCellDisplay(rowObj[colName]), isMissing: false };
}

function isSearchMatchedCell(rowId, colName) {
  return searchResult.value.matchedCellKeys.has(`${rowId}\x1f${colName}`);
}

function isActiveSearchCell(rowId, colName) {
  const active = activeSearchMatch.value;
  return Boolean(active && active.rowId === rowId && active.colName === colName);
}

function isActiveChangedRow(displayIndex) {
  const list = changedDisplayIndices.value;
  if (!list.length) return false;
  const idx = ((state.activeChangeIndex % list.length) + list.length) % list.length;
  return list[idx] === displayIndex;
}

function handleTimelineKeydown(event) {
  const list = filteredRevisions.value;
  if (!list.length) return;
  const currentIdx = list.findIndex((item) => item.id === selectedRevision.value?.id);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    const next = list[Math.min(list.length - 1, Math.max(0, currentIdx) + 1)];
    if (next) history.selectRevision(next.id);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    const prev = list[Math.max(0, currentIdx - 1)];
    if (prev) history.selectRevision(prev.id);
  }
}

function openInBackupCenter() {
  emit("open-backup-center", {
    connectionId: props.connectionId,
    database: props.database,
    tableName: props.tableName,
  });
}

// Auto-load when table identity changes
watch(
  () => [props.connectionId, props.database, props.tableName],
  ([connectionId, database, tableName]) => {
    if (!database || !tableName) return;
    columnWidths.value = {};
    void history.loadForTable({
      connectionId,
      database,
      tableName,
      tableComment: props.tableComment,
      tableMeta: props.tableMeta,
    });
  },
  { immediate: true },
);

// Re-fetch when user signs into team account so shared history loads immediately
watch(
  () => props.isLoggedIn,
  (loggedIn, prev) => {
    if (loggedIn && !prev && props.database && props.tableName) {
      void history.refresh();
    }
  },
);

// Auto-scroll to first changed row whenever revision / snapshot / scope changes
watch(
  () => [
    selectedRevision.value?.id || "",
    snapshot.value.mode,
    state.displayScope,
    state.liveLoading,
    snapshot.value.changedCount,
  ],
  async ([, mode, , liveLoading]) => {
    if (mode !== "full-table" || liveLoading) return;
    await nextTick();
    jumpToFirstChangedRow();
  },
);

// Scroll to active search match whenever query or match index updates
watch(
  () => [activeSearchMatch.value?.rowId, activeSearchMatch.value?.colName, state.activeMatchIndex],
  async () => {
    const match = activeSearchMatch.value;
    if (!match || !isFullTableMode.value) return;
    await nextTick();
    scrollToDisplayRow(match.displayIndex, match.colName);
  },
);

onMounted(() => {
  if (typeof ResizeObserver === "function" && beforeScrollerRef.value) {
    resizeObserver = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect?.height;
      if (height && Math.abs(height - viewportHeight.value) >= 1) {
        viewportHeight.value = height;
      }
    });
    resizeObserver.observe(beforeScrollerRef.value);
  }
});

watch(
  () => beforeScrollerRef.value,
  (el) => {
    if (resizeObserver) {
      resizeObserver.disconnect();
      if (el) {
        viewportHeight.value = el.clientHeight || viewportHeight.value;
        resizeObserver.observe(el);
      }
    }
  },
);

onBeforeUnmount(() => {
  history.dispose();
  endSplitterDrag();
  endColResize();
  if (syncReleaseFrame) cancelAnimationFrame(syncReleaseFrame);
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <section
    ref="rootRef"
    class="wb-thv-root"
    :aria-label="t('tableHistory.viewAria', { table: tableName })"
    @keydown="handleViewKeydown"
  >
    <!-- Top bar: [ 表数据 | 修改记录 ] + [ 完整表格 | 仅看改动行 ] + 改动定位 + 搜索 + 刷新 -->
    <header class="wb-thv-topbar">
      <div class="wb-thv-topbar-left">
        <div class="wb-table-view-switch" role="tablist" :aria-label="t('tableHistory.viewSwitchAria')">
          <button
            type="button"
            role="tab"
            aria-selected="false"
            class="wb-table-view-switch-btn"
            @click="emit('switch-view', 'data')"
          >
            <Table2 :size="13" :stroke-width="1.9" aria-hidden="true" />
            <span>{{ t('tableHistory.viewData') }}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected="true"
            class="wb-table-view-switch-btn is-active"
          >
            <History :size="13" :stroke-width="1.9" aria-hidden="true" />
            <span>{{ t('tableHistory.viewHistory') }}</span>
          </button>
        </div>

        <template v-if="isFullTableMode">
          <span class="wb-thv-topbar-sep" aria-hidden="true"></span>
          <div class="wb-thv-scope-switch" role="group" :aria-label="t('tableHistory.scopeAria')">
            <button
              type="button"
              class="wb-thv-scope-btn"
              :class="{ 'is-active': state.displayScope === 'full' }"
              :aria-pressed="state.displayScope === 'full'"
              @click="history.setDisplayScope('full')"
            >
              <span>{{ t('tableHistory.scopeFull') }}</span>
              <span class="wb-thv-scope-count">{{ snapshot.totalRows }}</span>
            </button>
            <button
              type="button"
              class="wb-thv-scope-btn"
              :class="{ 'is-active': state.displayScope === 'changed' }"
              :aria-pressed="state.displayScope === 'changed'"
              @click="history.setDisplayScope('changed')"
            >
              <span>{{ t('tableHistory.scopeChanged') }}</span>
              <span class="wb-thv-scope-count">{{ snapshot.changedCount }}</span>
            </button>
          </div>

          <div v-if="activeChangeDisplay" class="wb-thv-stepper">
            <span class="wb-thv-stepper-label">
              {{ t('tableHistory.changeStepLabel', activeChangeDisplay) }}
            </span>
            <button
              type="button"
              class="wb-thv-step-btn"
              :disabled="activeChangeDisplay.total <= 1"
              :title="t('tableHistory.prevChange')"
              :aria-label="t('tableHistory.prevChange')"
              @click="handleStepChange(-1)"
            >
              <ArrowUp :size="13" :stroke-width="2" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="wb-thv-step-btn"
              :disabled="activeChangeDisplay.total <= 1"
              :title="t('tableHistory.nextChange')"
              :aria-label="t('tableHistory.nextChange')"
              @click="handleStepChange(1)"
            >
              <ArrowDown :size="13" :stroke-width="2" aria-hidden="true" />
            </button>
          </div>
        </template>
      </div>

      <div class="wb-thv-topbar-right">
        <div class="wb-thv-search" :class="{ 'has-query': Boolean(state.searchQuery) }">
          <Search :size="13" :stroke-width="2" class="wb-thv-search-icon" aria-hidden="true" />
          <input
            ref="searchInputRef"
            type="text"
            :value="state.searchQuery"
            :placeholder="t('tableHistory.searchPlaceholder')"
            :aria-label="t('tableHistory.searchPlaceholder')"
            @input="history.setSearchQuery($event.target.value)"
            @keydown="handleSearchKeydown"
          />
          <template v-if="searchMatchDisplay">
            <span
              class="wb-thv-search-count"
              :class="{ 'is-empty': searchMatchDisplay.total === 0 }"
            >
              <template v-if="searchMatchDisplay.filterMode">
                {{ searchMatchDisplay.total }}
              </template>
              <template v-else>
                {{ searchMatchDisplay.current }} / {{ searchMatchDisplay.total }}
              </template>
            </span>
            <template v-if="!searchMatchDisplay.filterMode">
              <button
                type="button"
                class="wb-thv-search-nav"
                :disabled="searchMatchDisplay.total <= 1"
                :title="t('tableHistory.prevMatch')"
                :aria-label="t('tableHistory.prevMatch')"
                @click="handleStepSearchMatch(-1)"
              >
                <ChevronUp :size="13" :stroke-width="2" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="wb-thv-search-nav"
                :disabled="searchMatchDisplay.total <= 1"
                :title="t('tableHistory.nextMatch')"
                :aria-label="t('tableHistory.nextMatch')"
                @click="handleStepSearchMatch(1)"
              >
                <ChevronDown :size="13" :stroke-width="2" aria-hidden="true" />
              </button>
            </template>
            <button
              type="button"
              class="wb-thv-search-clear"
              :title="t('tableHistory.clearSearch')"
              :aria-label="t('tableHistory.clearSearch')"
              @click="history.setSearchQuery('')"
            >
              <X :size="12" :stroke-width="2.2" aria-hidden="true" />
            </button>
          </template>
        </div>

        <button
          type="button"
          class="wb-thv-icon-btn"
          :disabled="state.loading || state.liveLoading"
          :title="t('tableHistory.refresh')"
          :aria-label="t('tableHistory.refresh')"
          @click="history.refresh()"
        >
          <RefreshCw
            :size="14"
            :stroke-width="1.9"
            :class="{ 'is-spinning': state.loading || state.liveLoading }"
            aria-hidden="true"
          />
        </button>
      </div>
    </header>

    <!-- Conditional honest banners (only rendered when applicable) -->
    <div v-if="externalNotice" class="wb-thv-banner is-warn" role="status">
      <Info :size="14" :stroke-width="2" aria-hidden="true" />
      <span>{{ t('tableHistory.externalNewerNotice', { time: externalNotice.modifiedAt }) }}</span>
    </div>
    <div v-else-if="state.sharedStatus === 'logged-out'" class="wb-thv-banner is-info" role="status">
      <Info :size="14" :stroke-width="2" aria-hidden="true" />
      <span>{{ t('tableHistory.loggedOutNotice') }}</span>
    </div>
    <div v-if="state.liveTruncated && isFullTableMode" class="wb-thv-banner is-info" role="status">
      <Info :size="14" :stroke-width="2" aria-hidden="true" />
      <span>{{ t('tableHistory.liveTruncatedNotice', { limit: state.liveRows.length }) }}</span>
    </div>
    <div v-if="fallbackBannerText" class="wb-thv-banner is-info" role="status">
      <Info :size="14" :stroke-width="2" aria-hidden="true" />
      <span>{{ fallbackBannerText }}</span>
    </div>
    <div v-if="state.error" class="wb-thv-error-bar" role="alert">
      <AlertCircle :size="14" :stroke-width="2" aria-hidden="true" />
      <span>{{ state.error }}</span>
    </div>

    <!-- Main body: left revision timeline + right synchronized full-table comparison -->
    <div class="wb-thv-body">
      <aside class="wb-thv-rail" :aria-label="t('tableHistory.timelineAria')">
        <div class="wb-thv-rail-head">
          <span class="wb-thv-rail-title">{{ t('tableHistory.recentTitle') }}</span>
          <span v-if="state.revisions.length" class="wb-thv-rail-count">
            {{ t('tableHistory.revisionCount', { count: state.revisions.length }) }}
          </span>
        </div>

        <div v-if="actors.length >= 2" class="wb-thv-actor-filters" role="group" :aria-label="t('tableHistory.filterByActor')">
          <button
            type="button"
            class="wb-thv-actor-chip"
            :class="{ 'is-active': !state.actorFilter }"
            @click="history.setActorFilter('')"
          >{{ t('tableHistory.allActors') }}</button>
          <button
            v-for="item in actors"
            :key="item.name"
            type="button"
            class="wb-thv-actor-chip"
            :class="{ 'is-active': state.actorFilter === item.name }"
            @click="history.setActorFilter(item.name)"
          >
            <span>{{ item.name }}</span>
            <em>{{ item.count }}</em>
          </button>
        </div>

        <div
          class="wb-thv-timeline"
          role="listbox"
          tabindex="0"
          :aria-label="t('tableHistory.timelineAria')"
          @keydown="handleTimelineKeydown"
        >
          <template v-if="isInitialLoading">
            <div v-for="n in 5" :key="n" class="wb-thv-skeleton-rev">
              <span class="wb-thv-skeleton-line is-wide"></span>
              <span class="wb-thv-skeleton-line is-narrow"></span>
            </div>
          </template>
          <template v-else-if="filteredRevisions.length">
            <button
              v-for="rev in filteredRevisions"
              :key="rev.id"
              type="button"
              role="option"
              class="wb-thv-rev-item"
              :class="{ 'is-active': selectedRevision?.id === rev.id }"
              :aria-selected="selectedRevision?.id === rev.id"
              @click="history.selectRevision(rev.id)"
            >
              <div class="wb-thv-rev-top">
                <span class="wb-thv-rev-actor">
                  <span class="wb-thv-avatar" aria-hidden="true">{{ actorInitial(rev.actor) }}</span>
                  <span class="wb-thv-actor-name">{{ rev.actor }}</span>
                </span>
                <span class="wb-thv-rev-time" :title="fullTime(rev.ts)">{{ shortTime(rev.ts) }}</span>
              </div>
              <div class="wb-thv-rev-bottom">
                <span class="wb-thv-rev-source">{{ sourceLabel(rev.source, rev.isRollback) }}</span>
                <span class="wb-thv-rev-badges">
                  <span v-if="rev.counts.update" class="wb-thv-count-pill" data-kind="update">
                    {{ t('tableHistory.count.update', { count: rev.counts.update }) }}
                  </span>
                  <span v-if="rev.counts.insert" class="wb-thv-count-pill" data-kind="insert">
                    {{ t('tableHistory.count.insert', { count: rev.counts.insert }) }}
                  </span>
                  <span v-if="rev.counts.delete" class="wb-thv-count-pill" data-kind="delete">
                    {{ t('tableHistory.count.delete', { count: rev.counts.delete }) }}
                  </span>
                  <span v-if="rev.counts.ddl" class="wb-thv-count-pill" data-kind="ddl">
                    {{ t('tableHistory.count.ddl', { count: rev.counts.ddl }) }}
                  </span>
                </span>
              </div>
            </button>

            <button
              v-if="history.hasMore.value"
              type="button"
              class="wb-thv-load-more"
              :disabled="state.loadingMore"
              @click="history.loadMore()"
            >
              {{ state.loadingMore ? t('tableHistory.loadingMore') : t('tableHistory.loadMore') }}
            </button>
          </template>
          <div v-else class="wb-thv-rail-empty">
            <History :size="20" :stroke-width="1.6" aria-hidden="true" />
            <span>{{ t('tableHistory.noRevisionsShort') }}</span>
          </div>
        </div>

        <footer v-if="canOpenBackupCenter" class="wb-thv-rail-footer">
          <button type="button" class="wb-thv-link-btn" @click="openInBackupCenter">
            <ExternalLink :size="13" :stroke-width="1.9" aria-hidden="true" />
            <span>{{ t('tableHistory.openBackupCenter') }}</span>
          </button>
        </footer>
      </aside>

      <!-- Right comparison workspace -->
      <main class="wb-thv-stage">
        <div v-if="isInitialLoading" class="wb-thv-loading-stage">
          <div v-for="n in 6" :key="n" class="wb-thv-skeleton-row">
            <span class="wb-thv-skeleton-line is-narrow"></span>
            <span class="wb-thv-skeleton-line is-wide"></span>
            <span class="wb-thv-skeleton-line is-wide"></span>
          </div>
        </div>

        <div v-else-if="!selectedRevision" class="wb-thv-empty-state">
          <History :size="30" :stroke-width="1.5" aria-hidden="true" />
          <strong>{{ t('tableHistory.emptyTitle') }}</strong>
          <p>{{ t('tableHistory.emptyDescription') }}</p>
          <button type="button" class="wb-thv-empty-back-btn" @click="emit('switch-view', 'data')">
            <Table2 :size="14" :stroke-width="1.9" aria-hidden="true" />
            <span>{{ t('tableHistory.backToData') }}</span>
          </button>
        </div>

        <!-- Mode A: Synchronized Side-by-Side Full-Table Comparison -->
        <div
          v-else-if="isFullTableMode"
          ref="splitStageRef"
          class="wb-thv-split-stage"
          :class="{ 'is-dragging': draggingSplitter }"
          :style="splitStageStyle"
        >
          <!-- LEFT PANE: 修改前 -->
          <section class="wb-thv-pane is-before" :aria-label="t('tableHistory.beforePaneTitle')">
            <header class="wb-thv-pane-head is-before">
              <span class="wb-thv-pane-label">
                <span class="wb-thv-pane-dot is-before" aria-hidden="true"></span>
                <strong>{{ t('tableHistory.beforePaneTitle') }}</strong>
                <span class="wb-thv-pane-sub">{{ t('tableHistory.beforePaneSub') }}</span>
              </span>
              <span class="wb-thv-pane-time">{{ t('tableHistory.beforeTime', { time: fullTime(selectedRevision.ts) }) }}</span>
            </header>

            <div
              ref="beforeScrollerRef"
              class="wb-thv-grid-scroller"
              @scroll="onGridScroll('before', $event)"
            >
              <div class="wb-thv-grid-canvas" :style="{ width: gridTotalWidth }">
                <div class="wb-thv-grid-header" :style="{ gridTemplateColumns }">
                  <div class="wb-thv-col-head is-rownum">#</div>
                  <div
                    v-for="col in fullTableColumns"
                    :key="`before-h-${col.name}`"
                    class="wb-thv-col-head"
                    :class="{
                      'is-pk': col.primaryKey,
                      'is-search-header-hit': searchResult.matchedHeaderCols.has(col.name),
                    }"
                    :title="col.comment ? `${col.name} · ${col.comment}` : col.name"
                  >
                    <div class="wb-thv-col-head-top">
                      <KeyRound v-if="col.primaryKey" :size="11" :stroke-width="2.1" class="wb-thv-pk-icon" aria-hidden="true" />
                      <span class="wb-thv-col-name">{{ col.name }}</span>
                    </div>
                    <span v-if="col.comment" class="wb-thv-col-comment">{{ col.comment }}</span>
                    <span
                      class="wb-thv-col-resizer"
                      aria-hidden="true"
                      @pointerdown="beginColResize(col.name, $event)"
                      @dblclick.stop="resetColWidth(col.name)"
                    ></span>
                  </div>
                </div>

                <div class="wb-thv-virtual-spacer" :style="{ height: `${totalHeight}px` }">
                  <div
                    class="wb-thv-virtual-slice"
                    :style="{ transform: `translateY(${visibleRange.start * ROW_HEIGHT}px)` }"
                  >
                    <div
                      v-for="{ row, displayIndex } in visibleRows"
                      :key="`b-${row.id}`"
                      class="wb-thv-grid-row"
                      :class="[
                        `is-${row.status}`,
                        {
                          'is-active-change': isActiveChangedRow(displayIndex),
                          'is-search-row-hit': searchResult.matchedRowIds.has(row.id),
                        },
                      ]"
                      :style="{ gridTemplateColumns }"
                      :data-row-status="row.status"
                    >
                      <div class="wb-thv-cell is-rownum">{{ row.rowIndex + 1 }}</div>
                      <template v-if="row.status === 'inserted'">
                        <div
                          class="wb-thv-cell is-placeholder"
                          :style="{ gridColumn: `2 / span ${Math.max(1, fullTableColumns.length)}` }"
                        >
                          {{ t('tableHistory.placeholderBeforeInsert') }}
                        </div>
                      </template>
                      <template v-else>
                        <div
                          v-for="col in fullTableColumns"
                          :key="`b-${row.id}-${col.name}`"
                          class="wb-thv-cell"
                          :class="{
                            'is-pk': col.primaryKey,
                            'is-diff-before': row.status === 'updated' && row.changedCols.includes(col.name),
                            'is-deleted-cell': row.status === 'deleted',
                            'is-search-hit': isSearchMatchedCell(row.id, col.name),
                            'is-search-active': isActiveSearchCell(row.id, col.name),
                          }"
                          :title="cellDisplay(row.before, col.name).text"
                        >
                          <template v-if="row.status === 'updated' && row.cellDiffs[col.name]?.before">
                            <span v-if="row.cellDiffs[col.name].before.isNull" class="wb-thv-null-pill">NULL</span>
                            <span v-else-if="row.cellDiffs[col.name].before.isEmpty" class="wb-thv-empty-pill">{{ t('tableHistory.emptyString') }}</span>
                            <span v-else-if="row.cellDiffs[col.name].before.hasHighlight" class="wb-thv-cell-text">
                              <template v-for="(seg, idx) in splitSearchHighlight(row.cellDiffs[col.name].before.prefix, state.searchQuery)" :key="`bp-${idx}`">
                                <mark v-if="seg.match" class="wb-thv-search-mark">{{ seg.text }}</mark>
                                <template v-else>{{ seg.text }}</template>
                              </template><mark class="wb-thv-mark-del">
                                <template v-for="(seg, idx) in splitSearchHighlight(row.cellDiffs[col.name].before.changed, state.searchQuery)" :key="`bc-${idx}`">
                                  <mark v-if="seg.match" class="wb-thv-search-mark">{{ seg.text }}</mark>
                                  <template v-else>{{ seg.text }}</template>
                                </template>
                              </mark><template v-for="(seg, idx) in splitSearchHighlight(row.cellDiffs[col.name].before.suffix, state.searchQuery)" :key="`bs-${idx}`">
                                <mark v-if="seg.match" class="wb-thv-search-mark">{{ seg.text }}</mark>
                                <template v-else>{{ seg.text }}</template>
                              </template>
                            </span>
                            <span v-else class="wb-thv-cell-text">
                              <template v-for="(seg, idx) in splitSearchHighlight(row.cellDiffs[col.name].before.text, state.searchQuery)" :key="idx">
                                <mark v-if="seg.match" class="wb-thv-search-mark">{{ seg.text }}</mark>
                                <template v-else>{{ seg.text }}</template>
                              </template>
                            </span>
                          </template>
                          <template v-else>
                            <span v-if="cellDisplay(row.before, col.name).isNull" class="wb-thv-null-pill">NULL</span>
                            <span v-else-if="cellDisplay(row.before, col.name).isEmpty" class="wb-thv-empty-pill">{{ t('tableHistory.emptyString') }}</span>
                            <span v-else-if="cellDisplay(row.before, col.name).isMissing" class="wb-thv-missing-dash">—</span>
                            <span v-else class="wb-thv-cell-text">
                              <template v-for="(seg, idx) in splitSearchHighlight(cellDisplay(row.before, col.name).text, state.searchQuery)" :key="idx">
                                <mark v-if="seg.match" class="wb-thv-search-mark">{{ seg.text }}</mark>
                                <template v-else>{{ seg.text }}</template>
                              </template>
                            </span>
                          </template>
                        </div>
                      </template>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- CENTER DRAGGABLE SPLITTER -->
          <div
            class="wb-thv-splitter"
            role="separator"
            aria-orientation="vertical"
            :title="t('tableHistory.splitterHint')"
            @pointerdown="beginSplitterDrag"
            @dblclick="resetSplitter"
          ></div>

          <!-- RIGHT PANE: 修改后 -->
          <section class="wb-thv-pane is-after" :aria-label="t('tableHistory.afterPaneTitle')">
            <header class="wb-thv-pane-head is-after">
              <span class="wb-thv-pane-label">
                <span class="wb-thv-pane-dot is-after" aria-hidden="true"></span>
                <strong>{{ t('tableHistory.afterPaneTitle') }}</strong>
                <span class="wb-thv-pane-sub">
                  {{ selectedRevision.actor }} · {{ sourceLabel(selectedRevision.source, selectedRevision.isRollback) }}
                </span>
              </span>
              <span class="wb-thv-pane-time">{{ fullTime(selectedRevision.ts) }}</span>
            </header>

            <div
              ref="afterScrollerRef"
              class="wb-thv-grid-scroller"
              @scroll="onGridScroll('after', $event)"
            >
              <div class="wb-thv-grid-canvas" :style="{ width: gridTotalWidth }">
                <div class="wb-thv-grid-header" :style="{ gridTemplateColumns }">
                  <div class="wb-thv-col-head is-rownum">#</div>
                  <div
                    v-for="col in fullTableColumns"
                    :key="`after-h-${col.name}`"
                    class="wb-thv-col-head"
                    :class="{
                      'is-pk': col.primaryKey,
                      'is-search-header-hit': searchResult.matchedHeaderCols.has(col.name),
                    }"
                    :title="col.comment ? `${col.name} · ${col.comment}` : col.name"
                  >
                    <div class="wb-thv-col-head-top">
                      <KeyRound v-if="col.primaryKey" :size="11" :stroke-width="2.1" class="wb-thv-pk-icon" aria-hidden="true" />
                      <span class="wb-thv-col-name">{{ col.name }}</span>
                    </div>
                    <span v-if="col.comment" class="wb-thv-col-comment">{{ col.comment }}</span>
                    <span
                      class="wb-thv-col-resizer"
                      aria-hidden="true"
                      @pointerdown="beginColResize(col.name, $event)"
                      @dblclick.stop="resetColWidth(col.name)"
                    ></span>
                  </div>
                </div>

                <div class="wb-thv-virtual-spacer" :style="{ height: `${totalHeight}px` }">
                  <div
                    class="wb-thv-virtual-slice"
                    :style="{ transform: `translateY(${visibleRange.start * ROW_HEIGHT}px)` }"
                  >
                    <div
                      v-for="{ row, displayIndex } in visibleRows"
                      :key="`a-${row.id}`"
                      class="wb-thv-grid-row"
                      :class="[
                        `is-${row.status}`,
                        {
                          'is-active-change': isActiveChangedRow(displayIndex),
                          'is-search-row-hit': searchResult.matchedRowIds.has(row.id),
                        },
                      ]"
                      :style="{ gridTemplateColumns }"
                      :data-row-status="row.status"
                    >
                      <div class="wb-thv-cell is-rownum">{{ row.rowIndex + 1 }}</div>
                      <template v-if="row.status === 'deleted'">
                        <div
                          class="wb-thv-cell is-placeholder"
                          :style="{ gridColumn: `2 / span ${Math.max(1, fullTableColumns.length)}` }"
                        >
                          {{ t('tableHistory.placeholderAfterDelete') }}
                        </div>
                      </template>
                      <template v-else>
                        <div
                          v-for="col in fullTableColumns"
                          :key="`a-${row.id}-${col.name}`"
                          class="wb-thv-cell"
                          :class="{
                            'is-pk': col.primaryKey,
                            'is-diff-after': row.status === 'updated' && row.changedCols.includes(col.name),
                            'is-inserted-cell': row.status === 'inserted',
                            'is-search-hit': isSearchMatchedCell(row.id, col.name),
                            'is-search-active': isActiveSearchCell(row.id, col.name),
                          }"
                          :title="cellDisplay(row.after, col.name).text"
                        >
                          <template v-if="row.status === 'updated' && row.cellDiffs[col.name]?.after">
                            <span v-if="row.cellDiffs[col.name].after.isNull" class="wb-thv-null-pill">NULL</span>
                            <span v-else-if="row.cellDiffs[col.name].after.isEmpty" class="wb-thv-empty-pill">{{ t('tableHistory.emptyString') }}</span>
                            <span v-else-if="row.cellDiffs[col.name].after.hasHighlight" class="wb-thv-cell-text">
                              <template v-for="(seg, idx) in splitSearchHighlight(row.cellDiffs[col.name].after.prefix, state.searchQuery)" :key="`ap-${idx}`">
                                <mark v-if="seg.match" class="wb-thv-search-mark">{{ seg.text }}</mark>
                                <template v-else>{{ seg.text }}</template>
                              </template><mark class="wb-thv-mark-ins">
                                <template v-for="(seg, idx) in splitSearchHighlight(row.cellDiffs[col.name].after.changed, state.searchQuery)" :key="`ac-${idx}`">
                                  <mark v-if="seg.match" class="wb-thv-search-mark">{{ seg.text }}</mark>
                                  <template v-else>{{ seg.text }}</template>
                                </template>
                              </mark><template v-for="(seg, idx) in splitSearchHighlight(row.cellDiffs[col.name].after.suffix, state.searchQuery)" :key="`as-${idx}`">
                                <mark v-if="seg.match" class="wb-thv-search-mark">{{ seg.text }}</mark>
                                <template v-else>{{ seg.text }}</template>
                              </template>
                            </span>
                            <span v-else class="wb-thv-cell-text">
                              <template v-for="(seg, idx) in splitSearchHighlight(row.cellDiffs[col.name].after.text, state.searchQuery)" :key="idx">
                                <mark v-if="seg.match" class="wb-thv-search-mark">{{ seg.text }}</mark>
                                <template v-else>{{ seg.text }}</template>
                              </template>
                            </span>
                          </template>
                          <template v-else>
                            <span v-if="cellDisplay(row.after, col.name).isNull" class="wb-thv-null-pill">NULL</span>
                            <span v-else-if="cellDisplay(row.after, col.name).isEmpty" class="wb-thv-empty-pill">{{ t('tableHistory.emptyString') }}</span>
                            <span v-else-if="cellDisplay(row.after, col.name).isMissing" class="wb-thv-missing-dash">—</span>
                            <span v-else class="wb-thv-cell-text">
                              <template v-for="(seg, idx) in splitSearchHighlight(cellDisplay(row.after, col.name).text, state.searchQuery)" :key="idx">
                                <mark v-if="seg.match" class="wb-thv-search-mark">{{ seg.text }}</mark>
                                <template v-else>{{ seg.text }}</template>
                              </template>
                            </span>
                          </template>
                        </div>
                      </template>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>

        <!-- Mode B: Honest Field-Level Fallback Diff (legacy teammate UPDATE without PK / DDL / no-PK table) -->
        <div v-else-if="isFieldDiffMode" class="wb-thv-fallback">
          <div class="wb-thv-fallback-head">
            <span class="wb-thv-avatar is-lg" aria-hidden="true">{{ actorInitial(selectedRevision.actor) }}</span>
            <div class="wb-thv-fallback-who">
              <div class="wb-thv-fallback-who-line">
                <strong>{{ selectedRevision.actor }}</strong>
                <span v-if="selectedRevision.username && selectedRevision.username !== selectedRevision.actor" class="wb-thv-fallback-username">
                  @{{ selectedRevision.username }}
                </span>
                <span class="wb-thv-fallback-source-tag">
                  {{ sourceLabel(selectedRevision.source, selectedRevision.isRollback) }}
                </span>
              </div>
              <span class="wb-thv-fallback-time">{{ fullTime(selectedRevision.ts) }}</span>
            </div>
          </div>

          <div class="wb-thv-fallback-scroll">
            <div v-if="!filteredFallbackItems.length" class="wb-thv-fallback-empty">
              <p>{{ t('tableHistory.noDiffMatch') }}</p>
              <button
                v-if="state.searchQuery"
                type="button"
                class="wb-thv-link-btn"
                @click="history.setSearchQuery('')"
              >{{ t('tableHistory.clearSearch') }}</button>
            </div>
            <template v-else>
              <div class="wb-thv-fallback-colhead" role="row">
                <span>{{ t('tableHistory.colField') }}</span>
                <span>{{ t('tableHistory.colBefore') }}</span>
                <span>{{ t('tableHistory.colAfter') }}</span>
              </div>

              <div class="wb-thv-fallback-groups">
                <section
                  v-for="(item, itemIdx) in filteredFallbackItems"
                  :key="`${item.id}-${itemIdx}`"
                  class="wb-thv-fallback-group"
                >
                  <header class="wb-thv-fallback-group-head">
                    <span class="wb-thv-op-tag" :data-op="item.operation">
                      {{ isRollbackEntry(item) ? t('tableHistory.source.rollback') : item.operation }}
                    </span>
                    <span v-if="item.rowIdentity.length" class="wb-thv-row-pk">
                      <span
                        v-for="(pair, pairIdx) in item.rowIdentity"
                        :key="pair.key"
                        class="wb-thv-pk-pair"
                      >
                        <template v-if="pairIdx > 0"><span class="wb-thv-pk-sep">·</span></template>
                        <em>{{ pair.key }}</em>={{ pair.value }}
                      </span>
                    </span>
                    <span v-else-if="filteredFallbackItems.length > 1" class="wb-thv-row-ordinal">
                      {{ t('tableHistory.rowOrdinal', { index: itemIdx + 1 }) }}
                    </span>
                    <span v-if="item.notes" class="wb-thv-row-notes">{{ item.notes }}</span>
                  </header>

                  <template v-if="item.operation === 'DDL'">
                    <div class="wb-thv-ddl-box">
                      <ul v-if="item.ddlItems.length" class="wb-thv-ddl-list">
                        <li v-for="(desc, dIdx) in item.ddlItems" :key="dIdx">{{ desc }}</li>
                      </ul>
                      <details v-if="item.forwardSql" class="wb-thv-ddl-sql">
                        <summary>{{ t('tableHistory.viewSql') }}</summary>
                        <pre>{{ item.forwardSql }}</pre>
                      </details>
                    </div>
                  </template>

                  <template v-else-if="item.operation === 'INSERT' || item.operation === 'DELETE'">
                    <div
                      v-for="(rf, rfIdx) in item.rowFields"
                      :key="`${rf.field}-${rfIdx}`"
                      class="wb-thv-fallback-row"
                    >
                      <div class="wb-thv-fallback-field">
                        <span class="wb-thv-field-name">{{ rf.field || t('tableHistory.rowContent') }}</span>
                        <span v-if="fieldComment(rf.field)" class="wb-thv-field-comment">{{ fieldComment(rf.field) }}</span>
                      </div>
                      <div
                        class="wb-thv-fallback-val"
                        :class="item.operation === 'DELETE' ? 'is-before' : 'is-absent'"
                      >
                        <template v-if="item.operation === 'DELETE'">
                          <span v-if="rf.value.isNull" class="wb-thv-null-pill">NULL</span>
                          <span v-else-if="rf.value.isEmpty" class="wb-thv-empty-pill">{{ t('tableHistory.emptyString') }}</span>
                          <span v-else class="wb-thv-val-text">{{ rf.value.text }}</span>
                        </template>
                        <span v-else class="wb-thv-missing-dash">—</span>
                      </div>
                      <div
                        class="wb-thv-fallback-val"
                        :class="item.operation === 'INSERT' ? 'is-after' : 'is-absent'"
                      >
                        <template v-if="item.operation === 'INSERT'">
                          <span v-if="rf.value.isNull" class="wb-thv-null-pill">NULL</span>
                          <span v-else-if="rf.value.isEmpty" class="wb-thv-empty-pill">{{ t('tableHistory.emptyString') }}</span>
                          <span v-else class="wb-thv-val-text">{{ rf.value.text }}</span>
                        </template>
                        <span v-else class="wb-thv-missing-dash">—</span>
                      </div>
                    </div>
                  </template>

                  <template v-else-if="item.changes.length">
                    <div
                      v-for="(change, cIdx) in item.changes"
                      :key="`${change.field}-${cIdx}`"
                      class="wb-thv-fallback-row"
                    >
                      <div class="wb-thv-fallback-field">
                        <span class="wb-thv-field-name">{{ change.field || t('tableHistory.valueField') }}</span>
                        <span v-if="fieldComment(change.field)" class="wb-thv-field-comment">{{ fieldComment(change.field) }}</span>
                      </div>
                      <div class="wb-thv-fallback-val is-before">
                        <span v-if="change.before.isNull" class="wb-thv-null-pill">NULL</span>
                        <span v-else-if="change.before.isEmpty" class="wb-thv-empty-pill">{{ t('tableHistory.emptyString') }}</span>
                        <span v-else-if="change.before.hasHighlight" class="wb-thv-val-text">
                          {{ change.before.prefix }}<mark class="wb-thv-mark-del">{{ change.before.changed }}</mark>{{ change.before.suffix }}
                        </span>
                        <span v-else class="wb-thv-val-text">{{ change.before.text }}</span>
                      </div>
                      <div class="wb-thv-fallback-val is-after">
                        <span v-if="change.after.isNull" class="wb-thv-null-pill">NULL</span>
                        <span v-else-if="change.after.isEmpty" class="wb-thv-empty-pill">{{ t('tableHistory.emptyString') }}</span>
                        <span v-else-if="change.after.hasHighlight" class="wb-thv-val-text">
                          {{ change.after.prefix }}<mark class="wb-thv-mark-ins">{{ change.after.changed }}</mark>{{ change.after.suffix }}
                        </span>
                        <span v-else class="wb-thv-val-text">{{ change.after.text }}</span>
                      </div>
                    </div>
                  </template>

                  <div v-else class="wb-thv-no-detail-row">
                    {{ t('tableHistory.noFieldDetail') }}
                  </div>
                </section>
              </div>
            </template>
          </div>
        </div>
      </main>
    </div>
  </section>
</template>
