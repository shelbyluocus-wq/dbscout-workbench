<script>
export default { name: "WorkbenchSplitLayout" };
</script>

<script setup>
import { computed, onBeforeUnmount, ref } from "vue";

import { listPaneIds } from "../paneLayoutState.js";
import {
  publishedActiveTabForPane,
  visibleTabsForPane,
} from "../utils/tabPublication.js";
import WorkbenchPane from "./WorkbenchPane.vue";

const props = defineProps({
  layout: { type: Object, required: true },
  panes: { type: Object, required: true },
  tabs: { type: Array, default: () => [] },
  focusedPaneId: { type: String, default: "" },
  editState: { type: Object, required: true },
  invokeWorkbench: { type: Function, required: true },
  appState: { type: Object, required: true },
  homeTables: { type: Array, default: () => [] },
  homeClipboard: { type: Object, default: null },
  recentTableNames: { type: Array, default: () => [] },
  sqlDocuments: { type: Array, default: () => [] },
  currentConnectionId: { type: String, default: "" },
  schema: { type: Array, default: () => [] },
  connections: { type: Array, default: () => [] },
  databases: { type: Array, default: () => [] },
  fetchPage: { type: Function, required: true },
  loadNextPage: { type: Function, required: true },
  loadPreviousPage: { type: Function, required: true },
  jumpToTableBoundary: { type: Function, required: true },
  loadSearchResultPage: { type: Function, default: null },
  loadNextSearchResultPage: { type: Function, default: null },
  cancelSearchResultPage: { type: Function, default: null },
  toggleSort: { type: Function, required: true },
  applySort: { type: Function, required: true },
  rootPaneCount: { type: Number, default: 0 },
  leftEdge: { type: Boolean, default: true },
  rightEdge: { type: Boolean, default: true },
  topEdge: { type: Boolean, default: true },
});

const emit = defineEmits([
  "focus-pane",
  "split-pane",
  "close-pane",
  "resize-split",
  "activate-tab",
  "close-tab",
  "reorder-tab",
  "copy-tab-name",
  "tab-contextmenu",
  "table-contextmenu",
  "row-contextmenu",
  "detail-contextmenu",
  "open-design",
  "design-applied",
  "export",
  "import",
  "replace",
  "batch-export",
  "batch-import",
  "save-reminder",
  "state-change",
  "page-refreshed",
  "cell-committed",
  "schema-search-previous",
  "schema-search-next",
  "open-home-table",
  "copy-home-tables",
  "paste-home-tables",
  "rename-home-table",
  "delete-home-tables",
  "send-home-tables",
  "refresh-home",
  "home-visible-tables",
  "focus-home-table",
  "sql-schema-changed",
  "open-sql-library",
  "new-sql-query",
  "open-sql-document",
  "duplicate-sql-document",
  "rename-sql-document",
  "delete-sql-document",
  "open-sql-file",
]);

const draggingSplit = ref(null);
const totalPaneCount = computed(() => props.rootPaneCount || listPaneIds(props.layout).length);
const MIN_SPLIT_RATIO = 0.18;
const MAX_SPLIT_RATIO = 0.82;
const MAX_ADAPTIVE_MIN_RATIO = 0.45;
const MIN_HORIZONTAL_PANE_SIZE = 280;
const MIN_VERTICAL_PANE_SIZE = 160;

function tabsForPane(pane) {
  return visibleTabsForPane(props.tabs, pane);
}

function activeTabForPane(pane) {
  return publishedActiveTabForPane(props.tabs, pane);
}

function nodeKey(node) {
  if (node?.type === "pane") return `pane:${node.paneId || ""}`;
  if (node?.type === "split") return `split:${node.id || ""}`;
  return "missing";
}

function paneStyle(node, side) {
  const ratio = Number(node?.ratio);
  const size = `${Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0.5)) * 100}%`;
  return {
    flexBasis: side === "first" ? size : `calc(100% - ${size})`,
  };
}

function splitBounds(direction, span) {
  const minimumSize = direction === "vertical" ? MIN_VERTICAL_PANE_SIZE : MIN_HORIZONTAL_PANE_SIZE;
  const adaptiveMinimum = span > 0 ? minimumSize / span : MIN_SPLIT_RATIO;
  const min = Math.min(MAX_ADAPTIVE_MIN_RATIO, Math.max(MIN_SPLIT_RATIO, adaptiveMinimum));
  return { min, max: 1 - min };
}

function splitSpan(direction, element) {
  const rect = element?.parentElement?.getBoundingClientRect?.();
  if (!rect) return 0;
  return direction === "vertical" ? rect.height : rect.width;
}

function beginResize(node, event) {
  if (!node?.id) return;
  const container = event.currentTarget?.parentElement;
  const rect = container?.getBoundingClientRect?.();
  if (!rect) return;
  event.preventDefault();
  draggingSplit.value = {
    id: node.id,
    direction: node.direction,
    rect,
    bounds: splitBounds(node.direction, node.direction === "vertical" ? rect.height : rect.width),
  };
  window.addEventListener("mousemove", continueResize);
  window.addEventListener("mouseup", finishResize, { once: true });
}

function continueResize(event) {
  const drag = draggingSplit.value;
  if (!drag) return;
  const span = drag.direction === "vertical" ? drag.rect.height : drag.rect.width;
  if (span <= 0) return;
  const offset = drag.direction === "vertical"
    ? event.clientY - drag.rect.top
    : event.clientX - drag.rect.left;
  emit("resize-split", drag.id, Math.min(drag.bounds.max, Math.max(drag.bounds.min, offset / span)));
}

function finishResize() {
  window.removeEventListener("mousemove", continueResize);
  window.removeEventListener("mouseup", finishResize);
  draggingSplit.value = null;
}

function resizeWithKeyboard(node, event) {
  const direction = node?.direction === "vertical" ? "vertical" : "horizontal";
  const decrementKey = direction === "vertical" ? "ArrowUp" : "ArrowLeft";
  const incrementKey = direction === "vertical" ? "ArrowDown" : "ArrowRight";
  if (event.key !== decrementKey && event.key !== incrementKey) return;
  event.preventDefault();
  const bounds = splitBounds(direction, splitSpan(direction, event.currentTarget));
  const current = Number.isFinite(Number(node.ratio)) ? Number(node.ratio) : 0.5;
  const step = event.shiftKey ? 0.1 : 0.02;
  const next = current + (event.key === incrementKey ? step : -step);
  emit("resize-split", node.id, Math.min(bounds.max, Math.max(bounds.min, next)));
}

onBeforeUnmount(finishResize);
</script>

<template>
  <section
    v-if="layout?.type === 'split'"
    class="wb-split-layout"
    :class="[
      layout.direction === 'vertical' ? 'is-vertical' : 'is-horizontal',
      { 'is-resizing': draggingSplit?.id === layout.id },
    ]"
  >
    <div class="wb-split-child" :style="paneStyle(layout, 'first')">
      <WorkbenchSplitLayout
        :key="nodeKey(layout.first)"
        :layout="layout.first"
        :panes="panes"
        :tabs="tabs"
        :focused-pane-id="focusedPaneId"
        :edit-state="editState"
        :invoke-workbench="invokeWorkbench"
        :app-state="appState"
        :home-tables="homeTables"
        :home-clipboard="homeClipboard"
        :recent-table-names="recentTableNames"
        :sql-documents="sqlDocuments"
        :current-connection-id="currentConnectionId"
        :schema="schema"
        :connections="connections"
        :databases="databases"
        :fetch-page="fetchPage"
        :load-next-page="loadNextPage"
        :load-previous-page="loadPreviousPage"
        :jump-to-table-boundary="jumpToTableBoundary"
        :load-search-result-page="loadSearchResultPage"
        :load-next-search-result-page="loadNextSearchResultPage"
        :cancel-search-result-page="cancelSearchResultPage"
        :toggle-sort="toggleSort"
        :apply-sort="applySort"
        :root-pane-count="totalPaneCount"
        :left-edge="leftEdge"
        :right-edge="layout.direction === 'vertical' ? rightEdge : false"
        :top-edge="topEdge"
        @focus-pane="emit('focus-pane', $event)"
        @split-pane="(...args) => emit('split-pane', ...args)"
        @close-pane="emit('close-pane', $event)"
        @resize-split="(...args) => emit('resize-split', ...args)"
        @activate-tab="(...args) => emit('activate-tab', ...args)"
        @close-tab="(...args) => emit('close-tab', ...args)"
        @reorder-tab="(...args) => emit('reorder-tab', ...args)"
        @copy-tab-name="emit('copy-tab-name', $event)"
        @tab-contextmenu="emit('tab-contextmenu', $event)"
        @table-contextmenu="(...args) => emit('table-contextmenu', ...args)"
        @row-contextmenu="(...args) => emit('row-contextmenu', ...args)"
        @detail-contextmenu="(...args) => emit('detail-contextmenu', ...args)"
        @open-design="(...args) => emit('open-design', ...args)"
        @design-applied="emit('design-applied', $event)"
        @export="emit('export', $event)"
        @import="emit('import', $event)"
        @replace="emit('replace', $event)"
        @batch-export="emit('batch-export', $event)"
        @batch-import="emit('batch-import', $event)"
        @save-reminder="emit('save-reminder', $event)"
        @state-change="emit('state-change', $event)"
        @page-refreshed="emit('page-refreshed', $event)"
        @cell-committed="emit('cell-committed', $event)"
        @schema-search-previous="emit('schema-search-previous')"
        @schema-search-next="emit('schema-search-next')"
        @open-home-table="(...args) => emit('open-home-table', ...args)"
        @copy-home-tables="emit('copy-home-tables', $event)"
        @paste-home-tables="emit('paste-home-tables', $event)"
        @rename-home-table="emit('rename-home-table', $event)"
        @delete-home-tables="emit('delete-home-tables', $event)"
        @send-home-tables="emit('send-home-tables', $event)"
        @refresh-home="emit('refresh-home', $event)"
        @home-visible-tables="emit('home-visible-tables', $event)"
        @focus-home-table="(...args) => emit('focus-home-table', ...args)"
        @sql-schema-changed="emit('sql-schema-changed', $event)"
        @open-sql-library="emit('open-sql-library', $event)"
        @new-sql-query="(...args) => emit('new-sql-query', ...args)"
        @open-sql-document="(...args) => emit('open-sql-document', ...args)"
        @duplicate-sql-document="(...args) => emit('duplicate-sql-document', ...args)"
        @rename-sql-document="emit('rename-sql-document', $event)"
        @delete-sql-document="(...args) => emit('delete-sql-document', ...args)"
        @open-sql-file="(...args) => emit('open-sql-file', ...args)"
      />
    </div>
    <div
      class="wb-split-divider"
      role="separator"
      tabindex="0"
      :aria-orientation="layout.direction === 'vertical' ? 'horizontal' : 'vertical'"
      :aria-label="layout.direction === 'vertical' ? '调整上下分屏高度' : '调整左右分屏宽度'"
      aria-valuemin="18"
      aria-valuemax="82"
      :aria-valuenow="Math.round((Number(layout.ratio) || 0.5) * 100)"
      @mousedown="beginResize(layout, $event)"
      @keydown="resizeWithKeyboard(layout, $event)"
    ></div>
    <div class="wb-split-child" :style="paneStyle(layout, 'second')">
      <WorkbenchSplitLayout
        :key="nodeKey(layout.second)"
        :layout="layout.second"
        :panes="panes"
        :tabs="tabs"
        :focused-pane-id="focusedPaneId"
        :edit-state="editState"
        :invoke-workbench="invokeWorkbench"
        :app-state="appState"
        :home-tables="homeTables"
        :home-clipboard="homeClipboard"
        :recent-table-names="recentTableNames"
        :sql-documents="sqlDocuments"
        :current-connection-id="currentConnectionId"
        :schema="schema"
        :connections="connections"
        :databases="databases"
        :fetch-page="fetchPage"
        :load-next-page="loadNextPage"
        :load-previous-page="loadPreviousPage"
        :jump-to-table-boundary="jumpToTableBoundary"
        :load-search-result-page="loadSearchResultPage"
        :load-next-search-result-page="loadNextSearchResultPage"
        :cancel-search-result-page="cancelSearchResultPage"
        :toggle-sort="toggleSort"
        :apply-sort="applySort"
        :root-pane-count="totalPaneCount"
        :left-edge="layout.direction === 'vertical' ? leftEdge : false"
        :right-edge="rightEdge"
        :top-edge="layout.direction === 'vertical' ? false : topEdge"
        @focus-pane="emit('focus-pane', $event)"
        @split-pane="(...args) => emit('split-pane', ...args)"
        @close-pane="emit('close-pane', $event)"
        @resize-split="(...args) => emit('resize-split', ...args)"
        @activate-tab="(...args) => emit('activate-tab', ...args)"
        @close-tab="(...args) => emit('close-tab', ...args)"
        @reorder-tab="(...args) => emit('reorder-tab', ...args)"
        @copy-tab-name="emit('copy-tab-name', $event)"
        @tab-contextmenu="emit('tab-contextmenu', $event)"
        @table-contextmenu="(...args) => emit('table-contextmenu', ...args)"
        @row-contextmenu="(...args) => emit('row-contextmenu', ...args)"
        @detail-contextmenu="(...args) => emit('detail-contextmenu', ...args)"
        @open-design="(...args) => emit('open-design', ...args)"
        @design-applied="emit('design-applied', $event)"
        @export="emit('export', $event)"
        @import="emit('import', $event)"
        @replace="emit('replace', $event)"
        @batch-export="emit('batch-export', $event)"
        @batch-import="emit('batch-import', $event)"
        @save-reminder="emit('save-reminder', $event)"
        @state-change="emit('state-change', $event)"
        @page-refreshed="emit('page-refreshed', $event)"
        @cell-committed="emit('cell-committed', $event)"
        @schema-search-previous="emit('schema-search-previous')"
        @schema-search-next="emit('schema-search-next')"
        @open-home-table="(...args) => emit('open-home-table', ...args)"
        @copy-home-tables="emit('copy-home-tables', $event)"
        @paste-home-tables="emit('paste-home-tables', $event)"
        @rename-home-table="emit('rename-home-table', $event)"
        @delete-home-tables="emit('delete-home-tables', $event)"
        @send-home-tables="emit('send-home-tables', $event)"
        @refresh-home="emit('refresh-home', $event)"
        @home-visible-tables="emit('home-visible-tables', $event)"
        @focus-home-table="(...args) => emit('focus-home-table', ...args)"
        @sql-schema-changed="emit('sql-schema-changed', $event)"
        @open-sql-library="emit('open-sql-library', $event)"
        @new-sql-query="(...args) => emit('new-sql-query', ...args)"
        @open-sql-document="(...args) => emit('open-sql-document', ...args)"
        @duplicate-sql-document="(...args) => emit('duplicate-sql-document', ...args)"
        @rename-sql-document="emit('rename-sql-document', $event)"
        @delete-sql-document="(...args) => emit('delete-sql-document', ...args)"
        @open-sql-file="(...args) => emit('open-sql-file', ...args)"
      />
    </div>
  </section>

  <WorkbenchPane
    v-else-if="layout?.type === 'pane' && panes[layout.paneId]"
    :key="nodeKey(layout)"
    :pane="panes[layout.paneId]"
    :tabs="tabsForPane(panes[layout.paneId])"
    :all-tabs="tabs"
    :active-tab="activeTabForPane(panes[layout.paneId])"
    :edit-state="editState"
    :invoke-workbench="invokeWorkbench"
    :app-state="appState"
    :home-tables="homeTables"
    :home-clipboard="homeClipboard"
    :recent-table-names="recentTableNames"
    :sql-documents="sqlDocuments"
    :current-connection-id="currentConnectionId"
    :schema="schema"
    :connections="connections"
    :databases="databases"
    :is-focused="focusedPaneId === layout.paneId"
    :fetch-page="fetchPage"
    :load-next-page="loadNextPage"
    :load-previous-page="loadPreviousPage"
    :jump-to-table-boundary="jumpToTableBoundary"
    :load-search-result-page="loadSearchResultPage"
    :load-next-search-result-page="loadNextSearchResultPage"
    :cancel-search-result-page="cancelSearchResultPage"
    :toggle-sort="toggleSort"
    :apply-sort="applySort"
    :root-pane-count="totalPaneCount"
    :left-edge="leftEdge"
    :right-edge="rightEdge"
    :top-edge="topEdge"
    @focus-pane="emit('focus-pane', $event)"
    @split-pane="(...args) => emit('split-pane', ...args)"
    @close-pane="emit('close-pane', $event)"
    @activate-tab="(...args) => emit('activate-tab', ...args)"
    @close-tab="(...args) => emit('close-tab', ...args)"
    @reorder-tab="(...args) => emit('reorder-tab', ...args)"
    @copy-tab-name="emit('copy-tab-name', $event)"
    @tab-contextmenu="emit('tab-contextmenu', $event)"
    @table-contextmenu="(...args) => emit('table-contextmenu', ...args)"
    @row-contextmenu="(...args) => emit('row-contextmenu', ...args)"
    @detail-contextmenu="(...args) => emit('detail-contextmenu', ...args)"
    @open-design="(...args) => emit('open-design', ...args)"
    @design-applied="emit('design-applied', $event)"
    @export="emit('export', $event)"
    @import="emit('import', $event)"
    @replace="emit('replace', $event)"
    @batch-export="emit('batch-export', $event)"
    @batch-import="emit('batch-import', $event)"
    @save-reminder="emit('save-reminder', $event)"
    @state-change="emit('state-change', $event)"
    @page-refreshed="emit('page-refreshed', $event)"
    @cell-committed="emit('cell-committed', $event)"
    @schema-search-previous="emit('schema-search-previous')"
    @schema-search-next="emit('schema-search-next')"
    @open-home-table="(...args) => emit('open-home-table', ...args)"
    @copy-home-tables="emit('copy-home-tables', $event)"
    @paste-home-tables="emit('paste-home-tables', $event)"
    @rename-home-table="emit('rename-home-table', $event)"
    @delete-home-tables="emit('delete-home-tables', $event)"
    @send-home-tables="emit('send-home-tables', $event)"
    @refresh-home="emit('refresh-home', $event)"
    @home-visible-tables="emit('home-visible-tables', $event)"
    @focus-home-table="(...args) => emit('focus-home-table', ...args)"
    @sql-schema-changed="emit('sql-schema-changed', $event)"
    @open-sql-library="emit('open-sql-library', $event)"
    @new-sql-query="(...args) => emit('new-sql-query', ...args)"
    @open-sql-document="(...args) => emit('open-sql-document', ...args)"
    @duplicate-sql-document="(...args) => emit('duplicate-sql-document', ...args)"
    @rename-sql-document="emit('rename-sql-document', $event)"
    @delete-sql-document="(...args) => emit('delete-sql-document', ...args)"
    @open-sql-file="(...args) => emit('open-sql-file', ...args)"
  />
</template>
