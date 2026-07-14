<script>
export default { name: "WorkbenchSplitLayout" };
</script>

<script setup>
import { computed, ref } from "vue";

import { listPaneIds } from "../paneLayoutState.js";
import {
  publishedActiveTabForPane,
  publishedTabsForPane,
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
  fetchPage: { type: Function, required: true },
  loadNextPage: { type: Function, required: true },
  loadSearchResultPage: { type: Function, default: null },
  loadNextSearchResultPage: { type: Function, default: null },
  cancelSearchResultPage: { type: Function, default: null },
  toggleSort: { type: Function, required: true },
  applySort: { type: Function, required: true },
  rootPaneCount: { type: Number, default: 0 },
  leftEdge: { type: Boolean, default: true },
  rightEdge: { type: Boolean, default: true },
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
  "refresh-home",
  "home-visible-tables",
  "focus-home-table",
]);

const draggingSplit = ref(null);
const totalPaneCount = computed(() => props.rootPaneCount || listPaneIds(props.layout).length);

function tabsForPane(pane) {
  return publishedTabsForPane(props.tabs, pane);
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
  emit("resize-split", drag.id, offset / span);
}

function finishResize() {
  window.removeEventListener("mousemove", continueResize);
  draggingSplit.value = null;
}
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
        :fetch-page="fetchPage"
        :load-next-page="loadNextPage"
        :load-search-result-page="loadSearchResultPage"
        :load-next-search-result-page="loadNextSearchResultPage"
        :cancel-search-result-page="cancelSearchResultPage"
        :toggle-sort="toggleSort"
        :apply-sort="applySort"
        :root-pane-count="totalPaneCount"
        :left-edge="leftEdge"
        :right-edge="layout.direction === 'vertical' ? rightEdge : false"
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
        @refresh-home="emit('refresh-home', $event)"
        @home-visible-tables="emit('home-visible-tables', $event)"
        @focus-home-table="(...args) => emit('focus-home-table', ...args)"
      />
    </div>
    <div
      class="wb-split-divider"
      role="separator"
      :aria-orientation="layout.direction === 'vertical' ? 'horizontal' : 'vertical'"
      @mousedown="beginResize(layout, $event)"
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
        :fetch-page="fetchPage"
        :load-next-page="loadNextPage"
        :load-search-result-page="loadSearchResultPage"
        :load-next-search-result-page="loadNextSearchResultPage"
        :cancel-search-result-page="cancelSearchResultPage"
        :toggle-sort="toggleSort"
        :apply-sort="applySort"
        :root-pane-count="totalPaneCount"
        :left-edge="layout.direction === 'vertical' ? leftEdge : false"
        :right-edge="rightEdge"
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
        @refresh-home="emit('refresh-home', $event)"
        @home-visible-tables="emit('home-visible-tables', $event)"
        @focus-home-table="(...args) => emit('focus-home-table', ...args)"
      />
    </div>
  </section>

  <WorkbenchPane
    v-else-if="layout?.type === 'pane' && panes[layout.paneId]"
    :key="nodeKey(layout)"
    :pane="panes[layout.paneId]"
    :tabs="tabsForPane(panes[layout.paneId])"
    :active-tab="activeTabForPane(panes[layout.paneId])"
    :edit-state="editState"
    :invoke-workbench="invokeWorkbench"
    :app-state="appState"
    :home-tables="homeTables"
    :home-clipboard="homeClipboard"
    :recent-table-names="recentTableNames"
    :is-focused="focusedPaneId === layout.paneId"
    :fetch-page="fetchPage"
    :load-next-page="loadNextPage"
    :load-search-result-page="loadSearchResultPage"
    :load-next-search-result-page="loadNextSearchResultPage"
    :cancel-search-result-page="cancelSearchResultPage"
    :toggle-sort="toggleSort"
    :apply-sort="applySort"
    :root-pane-count="totalPaneCount"
    :left-edge="leftEdge"
    :right-edge="rightEdge"
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
    @refresh-home="emit('refresh-home', $event)"
    @home-visible-tables="emit('home-visible-tables', $event)"
    @focus-home-table="(...args) => emit('focus-home-table', ...args)"
  />
</template>
