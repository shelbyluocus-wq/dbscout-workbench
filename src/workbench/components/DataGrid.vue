<script setup>
import { t } from "../i18n/index.js";
import { tPlatform } from "../utils/platformLabels.js";
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowDownToLine, ArrowUpToLine, Check, ChevronDown, ChevronUp, Filter, History, Link2, ListFilter, LoaderCircle, MessageSquareText, Plus, Search, X } from "lucide-vue-next";
import { DefaultTableIcon as Table2 } from "./workbenchIcons.js";
import { formatColumnFilterChip, getColumnFilter, normalizeColumnFilters } from "../utils/columnFilter.js";
import { isCellPending, getCellError, collectCellStatesForTable } from "../editState.js";
import { tabRowAt, tabRowCount, tabRows } from "../rowStore.js";
import { columnName } from "../utils/normalize.js";
import { isNumericColumnType } from "../utils/columnTypes.js";
import { displayCellValue } from "../utils/cellDisplay.js";
import { buildRowKey } from "../utils/rowIdentity.js";
import { COL_RESIZE_MIN_WIDTH, GRID_HEADER_HEIGHT, MIN_COL_WIDTH, ROW_INDEX_WIDTH } from "../constants.js";
import { useColumnResize, ensureColumnWidthState } from "../composables/useColumnResize.js";
import { useColumnReorder } from "../composables/useColumnReorder.js";
import { columnReorderSurfaceState } from "../utils/columnOrder.js";
import { useFreezePanes } from "../composables/useFreezePanes.js";
import { useGridRowResize } from "../composables/useGridRowResize.js";
import { applyResolvedFreeze, resolveFreezeTarget } from "../utils/freezeSelection.js";
import { sampleNextFrame } from "../utils/performanceMarks.js";
import { normalizeTableFilterMode } from "../utils/tableFilterMode.js";
import { relationChipLabel } from "../utils/configRelations.js";
import { createTableMentionIndex } from "../utils/tableMentions.js";
import TableMentionText from "./TableMentionText.vue";
import { useConfigRelationContext } from "../composables/configRelationContext.js";
import {
  createTableImportToolbarActions,
  resolveTableImportToolbarEvent,
} from "../utils/tableImportToolbarActions.js";
import { connectionHasCapability } from "../utils/connectionKinds.js";
import { gridSelectionActualBounds } from "../utils/gridCellSelection.js";
import {
  clampRectToViewport,
  resolveFillPreviewTipPosition,
  resolveTargetBounds,
} from "../utils/fillOverlayGeometry.js";
import GridDataRow from "./GridDataRow.vue";
import { createCellEditorHandlers, vImeValue } from "../utils/imeInput.js";
import ColumnSortMenu from "./ColumnSortMenu.vue";
import ToolbarSplitButton from "./ToolbarSplitButton.vue";
import { useToolbarFit } from "../composables/useToolbarFit.js";

const workbenchFontSignature = inject("workbenchFontSignature", ref(""));
const configRelationContext = useConfigRelationContext();
const gridWrapRef = ref(null);
const gridViewportHeight = ref(0);
const searchInputRef = ref(null);
const searchFieldRef = ref(null);
const isCellDragging = ref(false);
const isRowDragging = ref(false);
const isFillDragging = ref(false);
const fillDragMoved = ref(false);
const fillDragStart = ref(null);
const fillDragPointer = ref(null);
const fillOverlayStyle = ref(null);
const fillOverlayPlacement = ref({ flipLeft: false, flipUp: false });
const fillPreviewOverlay = ref(null);
const fillPreviewTipStyle = ref(null);
const fillPreviewTipRef = ref(null);
const fillOptionsMenuRef = ref(null);
const fillOptionsOpen = ref(false);
const openToolbarMenu = ref("");
const gridShellRef = ref(null);
let lastPreviewClientRect = null;
defineExpose({ gridWrapRef });

const props = defineProps({
  tab: { type: Object, default: null },
  schema: { type: Array, default: () => [] },
  activeColumns: { type: Array, default: () => [] },
  columnWindow: { type: Object, default: null },
  activeColumnMeta: { type: Array, default: () => [] },
  visibleRows: { type: Array, default: () => [] },
  virtualRange: { type: Object, default: () => ({ start: 0, end: 0, padTop: 0, totalHeight: 0 }) },
  frozenRowsActive: { type: Boolean, default: true },
  selectedCell: { type: Object, default: null },
  selectedRange: { type: Object, default: null },
  isSelectingRange: { type: Boolean, default: false },
  showFillHandle: { type: Boolean, default: false },
  isFilling: { type: Boolean, default: false },
  fillPreview: { type: Object, default: null },
  fillSourceBounds: { type: Object, default: null },
  fillPreviewDetail: { type: Object, default: null },
  fillModifierActive: { type: Boolean, default: false },
  fillOptions: { type: Object, default: null },
  isCellInSelectedRange: { type: Function, default: () => false },
  getCellRangeClasses: { type: Function, default: () => ({}) },
  editingCell: { type: Object, default: null },
  editDraft: { type: String, default: "" },
  selectedInsertCell: { type: Object, default: null },
  selectedInsertRow: { type: Object, default: null },
  editState: { type: Object, required: true },
  busy: { type: Boolean, default: false },
  highlightCell: { type: Function, default: () => "" },
  hasSearchMatches: { type: Boolean, default: false },
  searchHitSummary: { type: Object, default: () => ({ current: 0, total: 0, label: "" }) },
  schemaSearchMatches: { type: Array, default: () => [] },
  schemaSearchIndex: { type: Number, default: -1 },
  schemaSearchSummary: { type: String, default: "" },
  getInsertRows: { type: Function, default: () => [] },
  getVisibleInsertRows: { type: Function, default: null },
  getInsertDraft: { type: Function, default: () => ({}) },
  getInsertRowKey: { type: Function, default: () => "" },
  isInsertRowVisible: { type: Function, default: () => false },
  isInsertRowSaving: { type: Function, default: () => false },
  insertAwareVisualRowIndex: { type: Function, default: null },
  isColumnSelected: { type: Function, default: () => false },
  engineKind: { type: String, default: "" },
  fetchDistinctValues: { type: Function, default: null },
});

const {
  getColumnWidth,
  resetColumnWidth,
  onHandleMouseDown,
  endColumnResize,
  onHandleKeyDown,
  autoFitColumnsRaf,
  autoFitColumns,
  dispose: disposeColumnResize,
} = useColumnResize();

// Both the renderer and useVirtualGrid read the tab-owned width state through
// useFreezePanes, so sticky offsets stay exact after a grid remount.
const freezePanes = useFreezePanes();

const activeTabRef = computed(() => props.tab);
const {
  rowHeight,
  fieldCommentHeight,
  startRowResize,
  resetRowHeight,
} = useGridRowResize(activeTabRef);
const gridHeightStyle = computed(() => ({
  "--wb-grid-row-height": `${rowHeight.value}px`,
  "--wb-grid-cell-height": `${Math.max(1, rowHeight.value - 1)}px`,
}));

const searchInputValue = ref("");
const activeTabReadOnly = computed(() => Boolean(props.tab?.readOnly || props.tab?.read_only));
const activeColumnFilters = computed(() => normalizeColumnFilters(props.tab?.columnFilters));
function columnFilterFor(name) {
  return getColumnFilter(activeColumnFilters.value, name);
}
const canImport = computed(() => connectionHasCapability(props.engineKind || "mysql", "import") && !activeTabReadOnly.value);
const canFindReplace = computed(() => connectionHasCapability(props.engineKind || "mysql", "findReplace") && !activeTabReadOnly.value);
const activeFilterMode = computed(() => normalizeTableFilterMode(props.tab?.filterMode));
const activeFilterModeLabel = computed(() => ({
  exact: t('m_235532a9c16b'),
  continuous: t('m_53b333e7b09d'),
  fuzzy: t('m_36bab7a3de7f'),
})[activeFilterMode.value]);
const filterModeItems = computed(() => ([
  {
    id: "filter-continuous",
    label: t('m_53b333e7b09d'),
    hint: t('m_93fe28912909'),
    checkable: true,
    checked: activeFilterMode.value === "continuous",
  },
  {
    id: "filter-exact",
    label: t('m_235532a9c16b'),
    hint: t('m_6b3862236d51'),
    checkable: true,
    checked: activeFilterMode.value === "exact",
  },
  {
    id: "filter-fuzzy",
    label: t('m_36bab7a3de7f'),
    hint: t('m_518505e811fe'),
    checkable: true,
    checked: activeFilterMode.value === "fuzzy",
  },
]));
const exportItems = computed(() => ([
  { id: "batch-export", label: t('m_d2fcdde81f06'), hint: t('m_5a41196d9d96'), icon: "export", disabled: props.busy },
]));
const importActions = computed(() => createTableImportToolbarActions({
  busy: props.busy,
  hasSession: Boolean(props.tab?.sessionId),
  readOnly: activeTabReadOnly.value,
  canImport: canImport.value,
  translate: t,
}));
const importItems = computed(() => importActions.value.menuItems);
const splitItems = computed(() => [
  { id: "split-right", label: t('m_62ed1b06404f'), hint: t('m_f4c8bce46e1b'), icon: "split-right" },
  { id: "split-down", label: t('m_3d63360a3d6e'), hint: t('m_6c7496f180d1'), icon: "split-down" },
]);
const hasActiveCellSearch = computed(() => Boolean(
  String(props.tab?.searchQuery ?? props.tab?.filter ?? "").trim(),
));
const relationChip = computed(() => relationChipLabel(props.tab, t));
const tableToolbarRef = ref(null);
// Fit levels: 0 full (Replace/Split already categorized in Tools), 1 Freeze folds into Tools,
// 2 icons only, 3 one categorized overflow menu.
const { fitLevel: toolbarFitLevel } = useToolbarFit(tableToolbarRef, {
  maxLevel: 3,
  contentSignature: () => [
    relationChip.value,
    props.tab?.sort?.columnName,
    props.tab?.sort?.descending,
    props.schemaSearchMatches.length ? props.schemaSearchSummary : "",
    props.searchHitSummary?.label,
    activeFilterModeLabel.value,
    importActions.value.primary.label,
    t("toolbar.tools"),
    workbenchFontSignature.value,
  ].join("\u001f"),
});

function clearRelationChip() {
  if (props.tab) configRelationContext?.clearRelationFilter?.(props.tab);
}

watch(
  () => [props.tab?.id, props.tab?.filter],
  ([, filter]) => {
    searchInputValue.value = String(filter ?? "");
  },
  { immediate: true },
);

const loadedRowCount = computed(() => tabRowCount(props.tab));
const rowWindowOffset = computed(() => Math.max(0, Math.floor(Number(props.tab?.rowWindowOffset) || 0)));
const boundaryNavigationDisabledReason = computed(() => {
  if (!props.tab?.searchResultMode) return "";
  return props.tab?.searchResultComplete
    ? t('m_99858e1da8a9')
    : t('m_9b2de0a6ccd0');
});

function dataRowKey(tab, row, rowIndex) {
  const precomputed = tab?.searchResultMode
    ? tab.searchResultRowKeys?.[rowIndex]
    : "";
  return precomputed || buildRowKey(tab, row);
}

const emit = defineEmits([
  'grid-ready',
  'scroll',
  'keydown',
  'paste',
  'cell-click',
  'cell-mousedown',
  'cell-enter',
  'range-pointer',
  'range-end',
  'fill-start',
  'fill-pointer',
  'fill-modifier',
  'fill-end',
  'fill-cancel',
  'fill-dblclick',
  'fill-option',
  'cell-dblclick',
  'cell-blur',
  'edit-input',
  'cell-input-start',
  'finish-edit',
  'cancel-edit',
  'tab-edit',
  'toggle-sort',
  'apply-sort',
  'toggle-search-filter',
  'apply-column-filter',
  'clear-column-filters',
  'toggle-row-select',
  'row-select-start',
  'row-select-pointer',
  'row-select-end',
  'toggle-all-rows',
  'insert-input',
  'insert-paste',
  'insert-focus',
  'insert-keydown',
  'insert-row-select',
  'save-insert-row',
  'cancel-insert-row',
  'insert-first-row',
  'append-row',
  'export',
  'import',
  'replace',
  'batch-export',
  'batch-import',
  'split-pane',
  'search-ready',
  'search-input',
  'search-previous',
  'search-next',
  'schema-search-previous',
  'schema-search-next',
  'contextmenu',
  'row-contextmenu',
  'select-column',
  'reorder-columns',
  'select-field-comment',
  'retry-load',
  'jump-boundary',
  'open-table',
  'switch-view',
]);

const {
  onCellEditorInput,
  onCellEditorCompositionStart,
  onCellEditorCompositionEnd,
  onCellEditorKeydown,
} = createCellEditorHandlers(emit);

const tableMentionIndex = computed(() => createTableMentionIndex(props.schema, {
  connectionId: props.tab?.connectionId,
  database: props.tab?.database,
}));

function openMentionedTable(table) {
  if (!table?.name) return;
  emit("open-table", {
    connectionId: props.tab?.connectionId || "",
    database: props.tab?.database || "",
    tableName: table.name,
    tableComment: table.comment || "",
  });
}

function colStyle(tab, colName) {
  const w = getColumnWidth(tab, colName);
  // Pin width/min/max together so the column honors an explicit width even
  // when it's narrower than its nowrap content's min-content (#13). Setting
  // maxWidth = w still allows widening past the auto-fit cap, since the cap
  // is enforced in autoFitColumns, not here — `w` itself is unbounded.
  return w ? { width: w + 'px', minWidth: w + 'px', maxWidth: w + 'px' } : {};
}

// ── Freeze panes geometry (reactive over tab.frozenRowCount/ColumnCount) ──
// Frozen rows render in their own band above the virtualized window; frozen
// columns get sticky left offsets. These computeds feed the render logic
// below so pinned columns stay aligned after a remount.
const configuredFrozenRowRange = computed(() => freezePanes.frozenRowRangeOf(
  props.tab,
  tabRowCount(props.tab),
  gridViewportHeight.value,
));
const frozenRowRange = computed(() => (
  props.frozenRowsActive
    ? configuredFrozenRowRange.value
    : { start: configuredFrozenRowRange.value.start, count: 0, end: configuredFrozenRowRange.value.start }
));
const frozenRowCount = computed(() => frozenRowRange.value.count);
const frozenRowStart = computed(() => frozenRowRange.value.start);
const frozenColumnCount = computed(() => freezePanes.frozenColumnCountOf(props.tab));
const columnReorder = useColumnReorder({
  getFrozenCount: () => frozenColumnCount.value,
  getGridWrap: () => gridWrapRef.value,
  onCommit({ sourceName, targetName, position }) {
    emit("reorder-columns", props.tab, sourceName, targetName, position);
  },
});
const columnReorderSurface = computed(() => columnReorderSurfaceState(columnReorder));
const frozenRowsHeight = computed(() => frozenRowCount.value * rowHeight.value);
const fieldCommentsExpanded = computed(() => props.tab?.fieldCommentsExpanded !== false);
const fieldCommentBandHeight = computed(() => (
  fieldCommentsExpanded.value ? fieldCommentHeight.value : freezePanes.fieldCommentBandHeight(props.tab)
));
const fieldCommentLineCount = computed(() => Math.max(1, Math.floor((fieldCommentBandHeight.value - 2) / 16.2)));
const frozenColumnsWidth = computed(() => freezePanes.frozenColumnsWidth(props.tab, renderColumns.value));
const hasFreeze = computed(() => configuredFrozenRowRange.value.count > 0 || frozenColumnCount.value > 0);
const freezeTarget = computed(() => resolveFreezeTarget({
  tabId: props.tab?.id,
  rowCount: tabRowCount(props.tab),
  selectedRange: props.selectedRange,
}));
const freezeItems = computed(() => ([
  {
    id: "freeze-cell",
    label: t('m_4fddbab9e400'),
    icon: "freeze-cell",
    disabled: freezeTarget.value?.kind !== "cell",
  },
  {
    id: "freeze-row",
    label: t('m_77fe132643d6'),
    icon: "freeze-row",
    disabled: freezeTarget.value?.kind !== "cell",
  },
  {
    id: "freeze-column",
    label: t('m_1ad2aff90018'),
    icon: "freeze-column",
    disabled: !freezeTarget.value,
  },
  { id: "freeze-top-row", label: t('m_d1ec96b9a1c9'), icon: "freeze-row" },
  { id: "freeze-first-column", label: t('m_e6f957238ec6'), icon: "freeze-column" },
  { id: "unfreeze", label: t('m_0592dd0b34a5'), icon: "unfreeze", disabled: !hasFreeze.value },
]));
const replaceMenuItem = computed(() => ({
  id: "replace",
  label: t('m_d688f871711e'),
  hint: t('m_a89a70b335c6'),
  icon: "replace",
  disabled: props.busy || !props.tab?.sessionId || !canFindReplace.value,
}));
// 不常用操作按分类收纳在「工具」悬停展开菜单中：编辑（查找替换）与视图（分屏；窄窗时并入冻结）。
const toolsActionItems = computed(() => {
  const editItems = [{
    ...replaceMenuItem.value,
    groupLabel: t('toolbar.groupEdit'),
  }];
  const viewItems = toolbarFitLevel.value > 0
    ? [
        ...freezeItems.value,
        ...splitItems.value.map((item, index) => ({
          ...item,
          separatorBefore: index === 0,
        })),
      ]
    : [...splitItems.value];
  if (viewItems.length) {
    viewItems[0] = { ...viewItems[0], groupLabel: t('toolbar.groupView') };
  }
  return [...editItems, ...viewItems];
});
const compactActionItems = computed(() => {
  const dataItems = [
    {
      id: "export-current",
      label: t('m_4a964617f078'),
      hint: t('m_4c3fa3b8f8c2'),
      icon: "export",
      disabled: props.busy,
      groupLabel: t('toolbar.groupData'),
    },
    ...exportItems.value,
    ...importActions.value.compactItems,
  ];
  const editItems = [{
    ...replaceMenuItem.value,
    groupLabel: t('toolbar.groupEdit'),
  }];
  const viewItems = [
    ...freezeItems.value,
    ...splitItems.value.map((item, index) => ({
      ...item,
      separatorBefore: index === 0,
    })),
  ];
  if (viewItems.length) {
    viewItems[0] = { ...viewItems[0], groupLabel: t('toolbar.groupView') };
  }
  return [...dataItems, ...editItems, ...viewItems];
});

// Rows rendered in the frozen band (always visible, outside the virtual window).
const frozenRows = computed(() => {
  const tab = props.tab;
  const start = frozenRowStart.value;
  const count = frozenRowCount.value;
  if (count <= 0 || tabRowCount(tab) === 0) return [];
  const entries = [];
  for (let frozenIndex = 0; frozenIndex < count; frozenIndex += 1) {
    const originalIndex = start + frozenIndex;
    const row = tabRowAt(tab, originalIndex);
    if (!row) continue;
    entries.push({
      row,
      originalIndex,
      frozenIndex,
      rowKey: dataRowKey(tab, row, originalIndex),
    });
  }
  return entries;
});

/**
 * Sticky style for a frozen column cell (th/td). Returns the `left` offset +
 * positioning; caller adds the z-index tier via class. Non-frozen columns get
 * an empty object (no sticky).
 */
function frozenColumnStyle(columnIndex) {
  if (columnIndex >= frozenColumnCount.value) return null;
  const left = freezePanes.frozenColumnLeftOffset(props.tab, renderColumns.value, columnIndex);
  return { position: 'sticky', left: left + 'px' };
}

/**
 * Sticky style for a frozen-row cell (td). `dataRowIndex` is the 0-based data
 * row index (not visual). Non-frozen rows get null.
 */
function frozenRowStyle(frozenIndex) {
  if (frozenIndex < 0 || frozenIndex >= frozenRowCount.value) return null;
  const top = freezePanes.frozenRowTopOffset(props.tab, frozenIndex);
  return { position: 'sticky', top: top + 'px' };
}

/**
 * Merge multiple style objects (later ones win on conflict). Used to combine
 * column width + frozen-column sticky + frozen-row sticky into one :style.
 */
function mergeStyles(...objs) {
  const out = {};
  for (const o of objs) {
    if (!o) continue;
    for (const k in o) out[k] = o[k];
  }
  return out;
}

// z-index tier class for a frozen cell, applied alongside frozenColumnStyle /
// frozenRowStyle. Tiers (see workbench.css):
//   frozen-col / frozen-row / frozen-corner (corner = both, highest)
function frozenCellClass(dataRowIndex, columnIndex) {
  const isFrozenRow = frozenRowCount.value > 0
    && dataRowIndex >= frozenRowStart.value
    && dataRowIndex < frozenRowStart.value + frozenRowCount.value;
  const isFrozenCol = columnIndex < frozenColumnCount.value;
  if (isFrozenRow && isFrozenCol) return 'frozen-corner';
  if (isFrozenCol) return 'frozen-col';
  if (isFrozenRow) return 'frozen-row';
  return '';
}

// Whether the last frozen column / last frozen row — used to draw the divider.
function isLastFrozenColumn(columnIndex) {
  return frozenColumnCount.value > 0 && columnIndex === frozenColumnCount.value - 1;
}
function isLastFrozenRow(dataRowIndex) {
  return frozenRowCount.value > 0 && dataRowIndex === frozenRowStart.value + frozenRowCount.value - 1;
}

// Highlight helper for #12: a column is "active" when the selected cell lives
// in the same column of the same tab. Used to tint the whole column (header +
// every visible td) so the user can trace the selected cell's column.
function isActiveColumn(colName) {
  return props.selectedCell?.tabId === props.tab.id && props.selectedCell?.column === colName;
}

const renderColumns = computed(() => {
  if (Array.isArray(props.activeColumnMeta) && props.activeColumnMeta.length) return props.activeColumnMeta;
  return (props.activeColumns || []).map((column, columnIndex) => ({
    column,
    columnIndex,
    name: columnName(column),
    comment: column?.column_comment || column?.columnComment || "",
    isNumeric: isNumericColumnType(column?.column_type ?? column?.columnType),
  }));
});

const renderCellColumns = computed(() => {
  const all = renderColumns.value;
  const segments = props.columnWindow?.segments || all.map((meta, index) => ({ kind: "column", index }));
  return segments.map((segment) => {
    if (segment.kind === "spacer") return {
      kind: "spacer", name: segment.key,
      cellStyle: { width: `${segment.width}px`, minWidth: `${segment.width}px`, maxWidth: `${segment.width}px` },
    };
    const meta = all[segment.index];
    return { ...meta, kind: "column", cellStyle: mergeStyles(colStyle(props.tab, meta.name), frozenColumnStyle(meta.columnIndex)) };
  });
});

// Column tint changes independently of data-row component updates.
const gridInstanceId = `grid-${Math.random().toString(36).slice(2)}`;
let activeColumnStyle = null;
watch(() => [props.selectedCell?.tabId, props.selectedCell?.column, props.tab?.id, renderColumns.value], () => {
  if (typeof document === "undefined") return;
  if (!activeColumnStyle) {
    activeColumnStyle = document.createElement("style");
    document.head.appendChild(activeColumnStyle);
  }
  const index = props.selectedCell?.tabId === props.tab?.id
    ? renderColumns.value.find((meta) => meta.name === props.selectedCell?.column)?.columnIndex : null;
  const selector = `[data-grid-id="${gridInstanceId}"] .wb-grid-row`;
  const cell = `td[data-column-index="${index}"]:not(.selected):not(.error):not(.row-selected)`;
  activeColumnStyle.textContent = index == null ? "" : `
    ${selector} ${cell} { background: color-mix(in srgb, var(--wb-cell-highlight) 18%, var(--wb-grid-row)); }
    ${selector}.row-even ${cell} { background: color-mix(in srgb, var(--wb-cell-highlight) 18%, var(--wb-grid-row-alt)); }
  `;
}, { immediate: true, flush: "post" });
onBeforeUnmount(() => activeColumnStyle?.remove());

function tabScopeKey(tab) {
  return tab?.tableKey || tab?.tableName || "";
}

const EMPTY_CELL_RANGE_CLASSES = Object.freeze({});

function cellRangeClasses(tab, rowKey, column, rowIndex, columnIndex) {
  if (!props.selectedRange || props.selectedRange.tabId !== tab?.id) return EMPTY_CELL_RANGE_CLASSES;
  return props.getCellRangeClasses(tab, rowKey, column, rowIndex, columnIndex);
}

function toggleFieldComments() {
  if (!props.tab) return;
  props.tab.fieldCommentsExpanded = !fieldCommentsExpanded.value;
}

function isFieldCommentSelected(columnNameValue) {
  return props.selectedCell?.tabId === props.tab?.id
    && props.selectedCell?.kind === "fieldComment"
    && props.selectedCell?.column === columnNameValue;
}

function selectFieldComment(columnMeta) {
  if (!fieldCommentsExpanded.value) return;
  emit("select-field-comment", props.tab, columnMeta);
}

function isRowInSelectedRange(tab, rowIndex) {
  const range = props.selectedRange;
  const anchorRow = range?.anchor?.rowIndex;
  const focusRow = range?.focus?.rowIndex;
  if (
    !range ||
    range.tabId !== tab?.id ||
    !Number.isInteger(rowIndex) ||
    !Number.isInteger(anchorRow) ||
    !Number.isInteger(focusRow)
  ) return false;
  return rowIndex >= Math.min(anchorRow, focusRow) && rowIndex <= Math.max(anchorRow, focusRow);
}

let lastScrollPerfSampleAt = 0;

// ── 边界跳转浮动按钮：按滚动位置与数据窗口状态按需出现 ────────────────
const boundaryScroll = ref({ top: 0, remaining: 0, viewport: 0 });
let boundaryScrollFrame = 0;
let pendingBoundaryScrollTarget = null;

function readBoundaryScrollMetrics(el) {
  if (!el) return;
  boundaryScroll.value = {
    top: el.scrollTop,
    remaining: el.scrollHeight - el.scrollTop - el.clientHeight,
    viewport: el.clientHeight,
  };
}

function scheduleBoundaryScrollUpdate(target) {
  if (!target) return;
  pendingBoundaryScrollTarget = target;
  if (boundaryScrollFrame) return;
  boundaryScrollFrame = requestAnimationFrame(() => {
    boundaryScrollFrame = 0;
    const el = pendingBoundaryScrollTarget;
    pendingBoundaryScrollTarget = null;
    readBoundaryScrollMetrics(el);
  });
}

watch(() => props.tab?.id, () => {
  boundaryScroll.value = { top: 0, remaining: 0, viewport: 0 };
});

// 不依赖滚动事件的主动测量：刚打开表（首屏数据渲染后）、翻页追加/前插、
// 面板尺寸变化时都重新读一次，保证"末行"胶囊在进入表格且不在底部时立即出现。
watch([loadedRowCount, gridViewportHeight], async () => {
  await nextTick();
  readBoundaryScrollMetrics(gridWrapRef.value);
});

onBeforeUnmount(() => {
  if (boundaryScrollFrame) cancelAnimationFrame(boundaryScrollFrame);
});

const showBoundaryJumpTop = computed(() => {
  const tab = props.tab;
  if (!tab || tab.loading || tab.loadError || !tab.sessionId) return false;
  if (boundaryNavigationDisabledReason.value) return false;
  if (Math.max(0, Math.floor(Number(tab.rowWindowOffset) || 0)) > 0) return true;
  const { top, viewport } = boundaryScroll.value;
  return viewport > 0 && top > viewport * 1.5;
});

const showBoundaryJumpBottom = computed(() => {
  const tab = props.tab;
  if (!tab || tab.loading || tab.loadError || !tab.sessionId) return false;
  if (boundaryNavigationDisabledReason.value) return false;
  if (!tab.fullyLoaded) return true;
  const { remaining, viewport } = boundaryScroll.value;
  return viewport > 0 && remaining > viewport * 0.5;
});

function onGridWrapScroll(event) {
  emit('scroll', event);
  updateFillOverlayPosition();
  scheduleBoundaryScrollUpdate(event?.target);
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  if (now - lastScrollPerfSampleAt > 250) {
    lastScrollPerfSampleAt = now;
    sampleNextFrame("grid.scroll.frame", {
      tableName: props.tab?.tableName || "",
      loadedRows: tabRowCount(props.tab),
      visibleRows: props.visibleRows.length,
      columns: props.activeColumns.length,
    });
  }
}

function isPrimaryKeyColumn(column, name = columnName(column)) {
  return Boolean(
    column?.is_primary_key ||
    column?.isPrimaryKey ||
    (name && props.tab?.primaryKeys?.includes?.(name))
  );
}

function insertRowObject(insertRow) {
  return { ...(insertRow?.draft || {}), __insertRowId: insertRow?.id };
}

function insertRowKey(tab, insertRow) {
  return props.getInsertRowKey(tab, insertRow?.id);
}

function insertCellSelected(insertRow, column) {
  return props.selectedCell?.tabId === props.tab.id
    && props.selectedCell?.rowKey === insertRowKey(props.tab, insertRow)
    && props.selectedCell?.column === column;
}

function insertCellEditing(insertRow, column) {
  return props.editingCell?.rowKey === insertRowKey(props.tab, insertRow)
    && props.editingCell?.column === column;
}

function insertEditorVisible(insertRow, column) {
  return !activeTabReadOnly.value && (insertCellSelected(insertRow, column) || insertCellEditing(insertRow, column));
}

function insertRowCellValueByName(tab, insertRow, name) {
  return props.getInsertDraft(tab, insertRow?.id)[name] || "";
}

function isSearchMatchCell(tab, row, column, rowKey) {
  return highlightCellResult(tab, row, column, rowKey).matched;
}

function highlightCellResult(tab, row, column, rowKey) {
  const result = props.highlightCell(tab, row, column, rowKey);
  if (result && typeof result === "object") return result;
  const html = String(result ?? "");
  return { html, matched: html.includes("<mark>") };
}

function highlightCellHtml(tab, row, column, rowKey) {
  const { html } = highlightCellResult(tab, row, column, rowKey);
  // 真实 NULL 单元格在网格里渲染为空白，而非字面 "NULL"（保留 .is-null 淡色标记）。
  // 仅当底层值为 null 且显示为 NULL 哨兵时清空：字面文本 "NULL" 或乐观编辑值不受影响。
  if (row?.[column] == null && html === "NULL") return "";
  return html;
}

function plainCellText(tab, row, column, rowKey) {
  const text = displayCellValue(props.editState, tab, row, column, rowKey);
  return row?.[column] == null && text === "NULL" ? "" : text;
}

// 按 anchorIndex 分组的草稿行：Map<anchorIndex, insertRow[]>，末尾追加草稿归入 key=null
// anchorIndex 超过已加载行数（例如删除/刷新后行数变少）也归入末尾，
// 避免未提交的 anchored 草稿因无对应数据行而消失、静默丢数据。
const insertRowsByAnchor = computed(() => {
  const map = new Map();
  const rows = typeof props.getVisibleInsertRows === "function"
    ? props.getVisibleInsertRows(props.tab)
    : (props.isInsertRowVisible(props.tab) ? props.getInsertRows(props.tab) : []);
  const rowCount = tabRowCount(props.tab);
  for (const row of rows) {
    let key = row.anchorIndex == null ? null : row.anchorIndex;
    if (key != null && key >= rowCount) key = null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
});

// 末尾追加草稿（anchorIndex==null），按存储顺序
const trailingInsertRows = computed(() => insertRowsByAnchor.value.get(null) || []);

// 是否存在任何插入草稿行（含锚定与末尾），用于判断 0 行空状态是否该显示。
const hasInsertRows = computed(() => {
  for (const rows of insertRowsByAnchor.value.values()) {
    if (rows.length > 0) return true;
  }
  return false;
});

const showAppendRowAction = computed(() => (
  !activeTabReadOnly.value
  && !props.tab?.loading
  && !props.tab?.loadingMore
  && !props.tab?.loadError
  && Boolean(props.tab?.fullyLoaded)
  && (loadedRowCount.value > 0 || hasInsertRows.value)
));

const visibleInsertRowCount = computed(() => {
  let count = 0;
  for (const rows of insertRowsByAnchor.value.values()) count += rows.length;
  return count;
});

const gridAriaRowCount = computed(() => (
  Math.max(tabRowCount(props.tab), Number(props.tab?.totalRows || 0)) + visibleInsertRowCount.value + 2
));

function gridCellDomId(tabId, rowKey, column) {
  return `wb-gridcell-${encodeURIComponent(String(tabId || ""))}-${encodeURIComponent(String(rowKey || ""))}-${encodeURIComponent(String(column || ""))}`;
}

const activeCellDomId = computed(() => {
  const cell = props.selectedCell;
  if (!cell || cell.tabId !== props.tab?.id || cell.kind === "fieldComment") return "";
  return gridCellDomId(cell.tabId, cell.rowKey, cell.column);
});

// 给定 originalIndex 处需在其前渲染的 anchored 草稿（anchorIndex===originalIndex）
function anchoredInsertRowsAt(originalIndex) {
  return insertRowsByAnchor.value.get(originalIndex) || [];
}

function anchoredInsertCountBefore(originalIndex) {
  let count = 0;
  for (const [anchorIndex, rows] of insertRowsByAnchor.value.entries()) {
    if (anchorIndex != null && anchorIndex < originalIndex) count += rows.length;
  }
  return count;
}

function anchoredInsertVisualIndex(originalIndex, insertRowIndex) {
  return originalIndex + anchoredInsertCountBefore(originalIndex) + insertRowIndex;
}

function dataRowVisualIndex(originalIndex) {
  // Local O(K) computation (K = number of insert drafts, typically tiny).
  // `insertRowsByAnchor` is a cached computed; `anchoredInsertCountBefore`
  // only walks that small map. This deliberately does NOT call
  // `props.insertAwareVisualRowIndex`, whose backing `visualRowEntries`
  // rebuilds an array over every data row on each call — calling that per
  // cell here made the grid O(visibleRows × columns × totalRows) and froze
  // large tables. The two formulas yield identical results.
  const currentAnchoredCount = anchoredInsertRowsAt(originalIndex).length;
  return originalIndex + anchoredInsertCountBefore(originalIndex) + currentAnchoredCount;
}

const visibleRowsWithVisualIndex = computed(() => props.visibleRows.map((entry) => ({
  ...entry,
  visualIndex: dataRowVisualIndex(entry.originalIndex),
})));

const rowCellStates = computed(() => collectCellStatesForTable(props.editState, tabScopeKey(props.tab)));
const frozenRowStyles = computed(() => Array.from({ length: frozenRowCount.value }, (_, index) => frozenRowStyle(index)));
const displayText = (row, column, key) => plainCellText(props.tab, row, column, key);
const highlightHtml = (row, column, key) => highlightCellHtml(props.tab, row, column, key);
const isSearchMatch = (row, column, key) => isSearchMatchCell(props.tab, row, column, key);
const rangeClassesByRow = computed(() => {
  const result = new Map();
  if (!props.selectedRange && !props.isFilling) return result;
  for (const entry of [...visibleRowsWithVisualIndex.value, ...frozenRows.value]) {
    const visualIndex = entry.visualIndex ?? dataRowVisualIndex(entry.originalIndex);
    const classes = {};
    for (const meta of renderColumns.value) {
      const value = props.getCellRangeClasses(props.tab, entry.rowKey, meta.name, visualIndex, meta.columnIndex);
      if (value?.["range-selected"]) classes[meta.name] = value;
    }
    if (Object.keys(classes).length) result.set(entry.rowKey, classes);
  }
  return result;
});

function rowModel(row, rowKey, originalIndex, visualIndex, rowVersion) {
  const isActiveRow = props.selectedCell?.tabId === props.tab.id && props.selectedCell?.rowKey === rowKey;
  const editingColumn = props.editingCell?.rowKey === rowKey ? props.editingCell.column : "";
  return {
    row, rowKey, originalIndex, visualIndex, rowVersion,
    rowNumber: rowWindowOffset.value + visualIndex + 1,
    isActiveRow,
    selectedColumn: isActiveRow ? props.selectedCell.column : "",
    editingColumn,
    editDraft: editingColumn ? props.editDraft : "",
    rowSelected: props.tab.selectedRowKeys.has(rowKey),
    inRowRange: isRowInSelectedRange(props.tab, visualIndex),
    rangeClasses: rangeClassesByRow.value.get(rowKey) || null,
    cellState: rowCellStates.value.get(rowKey) || null,
    canEdit: !activeTabReadOnly.value,
  };
}

function resolveDataCellTarget(event) {
  const target = event.target;
  if (!target?.closest || target.closest("input, textarea, button, .wb-row-index, tr.wb-insert-row")) return null;
  const td = target.closest(".wb-grid-row td[data-column-index]");
  if (!td || !gridWrapRef.value?.contains(td)) return null;
  const meta = renderColumns.value.find((column) => column.columnIndex === Number(td.dataset.columnIndex));
  const row = tabRowAt(props.tab, Number(td.dataset.originalIndex));
  return meta && row ? { td, row, meta, visualIndex: Number(td.dataset.visualRowIndex) } : null;
}
function onTbodyMouseDown(event) {
  if (event.button !== 0) return;
  const hit = resolveDataCellTarget(event);
  if (hit) onCellRangeStart(props.tab, hit.row, hit.meta.name, hit.visualIndex, hit.meta.columnIndex, event);
}
function dispatchCellEvent(name, event) {
  const hit = resolveDataCellTarget(event);
  if (hit) emit(name, props.tab, hit.row, hit.meta.name, hit.visualIndex, hit.meta.columnIndex);
}
function onTbodyMouseOver(event) {
  if (event.relatedTarget?.closest?.("td") === event.target?.closest?.("td")) return;
  dispatchCellEvent("cell-enter", event);
}
const onTbodyClick = (event) => dispatchCellEvent("cell-click", event);
const onTbodyDblClick = (event) => dispatchCellEvent("cell-dblclick", event);

const renderedVirtualRowCount = computed(() => {
  let count = props.visibleRows.length + trailingInsertRows.value.length;
  for (const { originalIndex } of props.visibleRows) {
    count += anchoredInsertRowsAt(originalIndex).length;
  }
  return count;
});

const virtualBottomSpacerHeight = computed(() => Math.max(
  0,
  Number(props.virtualRange.totalHeight || 0)
    - Number(props.virtualRange.padTop || 0)
    - renderedVirtualRowCount.value * rowHeight.value,
));

function trailingInsertVisualIndex(insertRowIndex) {
  return tabRowCount(props.tab) + anchoredInsertCountBefore(Number.POSITIVE_INFINITY) + insertRowIndex;
}

function schemaSearchColumnName(match) {
  return typeof match === "string" ? match : match?.columnName || "";
}

function isSchemaSearchColumn(column, name = columnName(column)) {
  return props.schemaSearchMatches.some((match) => schemaSearchColumnName(match) === name);
}

function isActiveSchemaSearchColumn(column, name = columnName(column)) {
  const match = props.schemaSearchMatches[props.schemaSearchIndex];
  return Boolean(match && schemaSearchColumnName(match) === name);
}

function continueRangeSelection(event) {
  if (!isCellDragging.value) return;
  if ((event.buttons & 1) === 0) {
    endRangeSelection();
    return;
  }
  emit('range-pointer', event);
}

function continueRowDragSelection(event) {
  if (!isRowDragging.value) return;
  if ((event.buttons & 1) === 0) {
    endRowSelection();
    return;
  }
  emit('row-select-pointer', props.tab, event);
}

function endRangeSelection() {
  if (!isCellDragging.value) return;
  isCellDragging.value = false;
  emit('range-end');
}

function endRowSelection() {
  if (!isRowDragging.value) return;
  isRowDragging.value = false;
  emit('row-select-end');
}

function endPointerSelections() {
  endRangeSelection();
  endRowSelection();
  cancelFillDragFromBlur();
}

function visibleGridDataRect(wrap) {
  const wrapRect = wrap.getBoundingClientRect();
  const theadRect = wrap.querySelector("thead")?.getBoundingClientRect();
  const contentTop = theadRect ? Math.max(wrapRect.top, theadRect.bottom) : wrapRect.top;
  const contentBottom = wrapRect.top + (wrap.clientHeight || wrapRect.height);
  const contentLeft = wrapRect.left + ROW_INDEX_WIDTH;
  const contentRight = wrapRect.left + (wrap.clientWidth || wrapRect.width);
  const frozenRowsList = wrap.querySelectorAll("tr.wb-frozen-row");
  const lastFrozenRowRect = frozenRowsList.length
    ? frozenRowsList[frozenRowsList.length - 1].getBoundingClientRect()
    : null;
  const frozenColEdge = wrap.querySelector("td.frozen-col-edge, th.frozen-col-edge")?.getBoundingClientRect() || null;
  return {
    wrapRect,
    contentTop,
    contentBottom,
    contentLeft,
    contentRight,
    frozenRowBottom: lastFrozenRowRect ? Math.max(contentTop, lastFrozenRowRect.bottom) : contentTop,
    frozenColRight: frozenColEdge ? Math.max(contentLeft, frozenColEdge.right) : contentLeft,
  };
}

function findVisibleCellCorner(wrap, rowIndex, columnIndex, viewport) {
  const cells = wrap.querySelectorAll(
    `td[data-visual-row-index="${rowIndex}"][data-column-index="${columnIndex}"]`,
  );
  let best = null;
  let score = Number.NEGATIVE_INFINITY;
  for (const cell of cells) {
    const rect = cell.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const isFrozenRowCell = Boolean(cell.closest("tr.wb-frozen-row"));
    const isFrozenColCell = cell.classList.contains("frozen-col") || cell.classList.contains("frozen-corner");
    const minTop = isFrozenRowCell ? viewport.contentTop : viewport.frozenRowBottom;
    const minLeft = isFrozenColCell ? viewport.contentLeft : viewport.frozenColRight;
    const cornerVisible = rect.right >= minLeft - 2
      && rect.right <= viewport.contentRight + 2
      && rect.bottom >= minTop - 2
      && rect.bottom <= viewport.contentBottom + 2;
    if (!cornerVisible) continue;
    const priority = (isFrozenRowCell ? 100000 : 0) + rect.right + rect.bottom;
    if (priority > score) {
      score = priority;
      best = rect;
    }
  }
  return best;
}

const isFillPreviewActive = computed(() => Boolean(props.isFilling && props.fillPreview?.fillCount > 0));
const isFillHandleHidden = computed(() => Boolean(isFillPreviewActive.value || (isFillDragging.value && fillDragMoved.value)));

function syncGlobalFillCursor() {
  const root = typeof document !== "undefined" ? document.documentElement : null;
  if (!root) return;
  const active = Boolean(isFillDragging.value || props.isFilling);
  root.classList.toggle("wb-fill-drag-active", active);
  root.classList.toggle("wb-fill-drag-toggle", active && Boolean(props.fillModifierActive));
}

function measureBoundsInViewport(wrap, bounds, viewport) {
  if (!wrap || !bounds || !viewport) return null;
  const findRow = (index) => {
    const rows = wrap.querySelectorAll(`tr[data-row-selection-index="${index}"]`);
    if (!rows.length) return null;
    let picked = rows[0];
    for (const candidate of rows) {
      if (candidate.classList.contains("wb-frozen-row")) {
        picked = candidate;
        break;
      }
    }
    return {
      rect: picked.getBoundingClientRect(),
      frozen: picked.classList.contains("wb-frozen-row"),
    };
  };
  const firstRendered = visibleRowsWithVisualIndex.value[0]?.visualIndex ?? 0;
  const topMatch = findRow(bounds.top);
  const bottomMatch = bounds.bottom === bounds.top ? topMatch : findRow(bounds.bottom);
  const rawTop = topMatch
    ? topMatch.rect.top
    : (bounds.top < firstRendered ? viewport.frozenRowBottom - 16 : viewport.contentBottom + 16);
  const rawBottom = bottomMatch
    ? bottomMatch.rect.bottom - 1
    : (bounds.bottom < firstRendered ? viewport.frozenRowBottom - 16 : viewport.contentBottom + 16);
  const minTop = topMatch?.frozen ? viewport.contentTop : viewport.frozenRowBottom;

  const findCol = (index) => {
    const cell = wrap.querySelector(`td[data-column-index="${index}"]`)
      || wrap.querySelector(`th[data-column-index="${index}"]`);
    if (!cell) return null;
    return {
      rect: cell.getBoundingClientRect(),
      frozen: cell.classList.contains("frozen-col") || cell.classList.contains("frozen-corner"),
    };
  };
  const leftMatch = findCol(bounds.left);
  const rightMatch = bounds.right === bounds.left ? leftMatch : findCol(bounds.right);
  if (!leftMatch || !rightMatch) return null;
  const minLeft = leftMatch.frozen ? viewport.contentLeft : viewport.frozenColRight;

  return clampRectToViewport(
    {
      left: leftMatch.rect.left,
      right: rightMatch.rect.right - 1,
      top: rawTop,
      bottom: rawBottom,
    },
    viewport,
    { minTop, minLeft },
  );
}

function overlayBoxStyle(box) {
  if (!box) return null;
  return {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  };
}

function sourceSeamClasses(box, direction) {
  if (!box || !direction) return {};
  return {
    "is-seam-bottom": direction === "down" && !box.clippedBottom,
    "is-seam-top": direction === "up" && !box.clippedTop,
    "is-seam-right": direction === "right" && !box.clippedRight,
    "is-seam-left": direction === "left" && !box.clippedLeft,
  };
}

function overlayClipClasses(box) {
  if (!box) return {};
  return {
    "is-clipped-top": box.clippedTop,
    "is-clipped-bottom": box.clippedBottom,
    "is-clipped-left": box.clippedLeft,
    "is-clipped-right": box.clippedRight,
  };
}

function updateFillPreviewTipOnly() {
  const wrap = gridWrapRef.value;
  const shell = gridShellRef.value;
  if (!wrap || !shell || !isFillPreviewActive.value || !props.fillPreviewDetail) {
    fillPreviewTipStyle.value = null;
    return;
  }
  const viewport = visibleGridDataRect(wrap);
  const shellRect = shell.getBoundingClientRect();
  const tipRect = fillPreviewTipRef.value?.getBoundingClientRect?.();
  const tipWidth = tipRect?.width > 0 ? tipRect.width : 124;
  const tipHeight = tipRect?.height > 0 ? tipRect.height : 26;
  const pos = resolveFillPreviewTipPosition({
    previewRect: lastPreviewClientRect,
    direction: props.fillPreview.direction,
    pointer: fillDragPointer.value,
    viewport,
    shellRect,
    tipWidth,
    tipHeight,
  });
  fillPreviewTipStyle.value = pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : null;
}

function updateFillOverlayPosition() {
  const wrap = gridWrapRef.value;
  const shell = gridShellRef.value;
  if (!wrap || !shell) {
    fillOverlayStyle.value = null;
    fillPreviewOverlay.value = null;
    fillPreviewTipStyle.value = null;
    lastPreviewClientRect = null;
    return;
  }
  const viewport = visibleGridDataRect(wrap);
  const shellRect = shell.getBoundingClientRect();

  if (isFillPreviewActive.value) {
    const previewBounds = props.fillPreview.previewBounds;
    const sourceBounds = props.fillSourceBounds || gridSelectionActualBounds(props.selectedRange);
    const direction = props.fillPreview.direction;
    const targetBounds = resolveTargetBounds(sourceBounds, direction, props.fillPreview.fillCount);
    const previewBox = measureBoundsInViewport(wrap, previewBounds, viewport);
    const sourceBox = measureBoundsInViewport(wrap, sourceBounds, viewport);
    const targetBox = measureBoundsInViewport(wrap, targetBounds, viewport);
    lastPreviewClientRect = previewBox;
    const clipWidth = Math.max(0, viewport.contentRight - viewport.contentLeft);
    const clipHeight = Math.max(0, viewport.contentBottom - viewport.contentTop);
    fillPreviewOverlay.value = previewBox && clipWidth > 0 && clipHeight > 0
      ? {
          clipStyle: {
            left: `${viewport.contentLeft - shellRect.left}px`,
            top: `${viewport.contentTop - shellRect.top}px`,
            width: `${clipWidth}px`,
            height: `${clipHeight}px`,
          },
          sourceStyle: overlayBoxStyle(sourceBox),
          sourceClasses: sourceSeamClasses(sourceBox, direction),
          targetStyle: overlayBoxStyle(targetBox),
          previewStyle: overlayBoxStyle(previewBox),
          previewClasses: overlayClipClasses(previewBox),
        }
      : null;

    if (props.fillPreviewDetail) {
      updateFillPreviewTipOnly();
    } else {
      fillPreviewTipStyle.value = null;
    }
    return;
  }

  fillPreviewOverlay.value = null;
  fillPreviewTipStyle.value = null;
  lastPreviewClientRect = null;

  if (!props.showFillHandle && !isFillDragging.value && !props.fillOptions?.canToggleMode) {
    fillOverlayStyle.value = null;
    return;
  }
  const bounds = gridSelectionActualBounds(props.selectedRange);
  if (!bounds) {
    fillOverlayStyle.value = null;
    return;
  }
  const best = findVisibleCellCorner(wrap, bounds.bottom, bounds.right, viewport);
  if (!best) {
    fillOverlayStyle.value = null;
    return;
  }
  fillOverlayPlacement.value = {
    flipLeft: viewport.contentRight - best.right < 156,
    flipUp: viewport.contentBottom - best.bottom < 112,
  };
  fillOverlayStyle.value = {
    left: `${best.right - shellRect.left}px`,
    top: `${best.bottom - shellRect.top}px`,
  };
}

function resetLocalFillDrag() {
  isFillDragging.value = false;
  fillDragMoved.value = false;
  fillDragStart.value = null;
  fillDragPointer.value = null;
}

function onFillHandleMouseDown(event) {
  fillOptionsOpen.value = false;
  // On the second click of a double-click, avoid starting a fresh drag session so native dblclick fires cleanly.
  if (event.detail >= 2) return;
  isFillDragging.value = true;
  fillDragMoved.value = false;
  fillDragStart.value = { x: event.clientX, y: event.clientY };
  fillDragPointer.value = { x: event.clientX, y: event.clientY };
  emit("fill-start", event);
}

function onFillHandleDoubleClick(event) {
  resetLocalFillDrag();
  fillOptionsOpen.value = false;
  emit("fill-dblclick", event);
}

function continueFillDrag(event) {
  if (!isFillDragging.value) return;
  if ((event.buttons & 1) === 0) {
    endFillDrag(event);
    return;
  }
  fillDragPointer.value = { x: event.clientX, y: event.clientY };
  if (!fillDragMoved.value && fillDragStart.value) {
    const dx = event.clientX - fillDragStart.value.x;
    const dy = event.clientY - fillDragStart.value.y;
    if (dx * dx + dy * dy < 9) return;
    fillDragMoved.value = true;
  }
  emit("fill-pointer", event);
  if (isFillPreviewActive.value) updateFillPreviewTipOnly();
}

function endFillDrag(event) {
  if (!isFillDragging.value) return;
  resetLocalFillDrag();
  emit("fill-end", event);
}

function cancelFillDragFromBlur() {
  if (!isFillDragging.value && !props.isFilling) return;
  resetLocalFillDrag();
  emit("fill-cancel");
}

function handleFillKeyEvent(event) {
  if (isFillDragging.value || props.isFilling) {
    if (event.key === "Escape") {
      resetLocalFillDrag();
      emit("fill-cancel");
      return;
    }
    emit("fill-modifier", event);
    return;
  }
  if (fillOptionsOpen.value && event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    fillOptionsOpen.value = false;
  }
}

function handleWindowMouseDownForFillOptions(event) {
  if (!fillOptionsOpen.value) return;
  if (event.target?.closest?.(".wb-fill-options")) return;
  fillOptionsOpen.value = false;
}

function toggleFillOptionsMenu() {
  fillOptionsOpen.value = !fillOptionsOpen.value;
  if (fillOptionsOpen.value) {
    nextTick(() => {
      const activeItem = fillOptionsMenuRef.value?.querySelector?.(".wb-fill-options-item.active")
        || fillOptionsMenuRef.value?.querySelector?.(".wb-fill-options-item");
      activeItem?.focus?.();
    });
  }
}

function onFillOptionsMenuKeydown(event) {
  const items = [...(fillOptionsMenuRef.value?.querySelectorAll?.(".wb-fill-options-item") || [])];
  if (!items.length) return;
  const currentIndex = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    items[(currentIndex + 1 + items.length) % items.length]?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    items[(currentIndex - 1 + items.length) % items.length]?.focus();
  } else if (event.key === "Home") {
    event.preventDefault();
    items[0]?.focus();
  } else if (event.key === "End") {
    event.preventDefault();
    items[items.length - 1]?.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    fillOptionsOpen.value = false;
    gridWrapRef.value?.focus?.();
  }
}

function chooseFillOption(mode) {
  fillOptionsOpen.value = false;
  emit("fill-option", mode);
}

function onRowSelectStart(tab, row, originalIndex, event) {
  isRowDragging.value = true;
  emit('row-select-start', tab, row, originalIndex, event, gridWrapRef.value);
}

function onCellRangeStart(tab, row, name, rowIndex, columnIndex, event) {
  if (event.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
  isCellDragging.value = true;
  emit('cell-mousedown', tab, row, name, rowIndex, columnIndex, event);
}

function onColumnHeaderPointerDown(tab, columnMeta, event) {
  if (event.target.closest(".wb-col-resize") || event.target.closest(".wb-sort-menu")) return;
  emit("select-column", tab, columnMeta.name, event);
  columnReorder.onHeaderPointerDown(
    event,
    columnMeta.columnIndex,
    columnMeta.name,
    event.currentTarget?.getBoundingClientRect?.().width,
  );
}

function setFilterMode(mode) {
  const tab = props.tab;
  if (!tab || tab.filterMode === mode) return;
  tab.filterMode = mode;
  if (searchInputValue.value) emit('search-input', searchInputValue.value);
}

function toggleToolbarMenu(menuId) {
  openToolbarMenu.value = openToolbarMenu.value === menuId ? "" : menuId;
}

function openToolbarMenuByHover(menuId) {
  if (openToolbarMenu.value && openToolbarMenu.value !== menuId) return;
  openToolbarMenu.value = menuId;
}

function closeToolbarMenu(menuId = "") {
  if (menuId && openToolbarMenu.value !== menuId) return;
  openToolbarMenu.value = "";
}

function applyFreezeCounts(freezeRows, freezeColumns) {
  return applyResolvedFreeze({
    freezePanes,
    tab: props.tab,
    target: { freezeRows, freezeColumns },
    scrollTop: gridWrapRef.value?.scrollTop || 0,
    viewportHeight: gridViewportHeight.value,
  });
}

function applyDefaultFreeze() {
  applyResolvedFreeze({
    freezePanes,
    tab: props.tab,
    target: freezeTarget.value,
    scrollTop: gridWrapRef.value?.scrollTop || 0,
    viewportHeight: gridViewportHeight.value,
  });
}

function handleFreezeAction(actionId) {
  const target = freezeTarget.value;
  if (actionId === "freeze-cell" && target?.kind === "cell") {
    applyFreezeCounts(target.freezeRows, target.freezeColumns);
  } else if (actionId === "freeze-row" && target?.kind === "cell") {
    applyFreezeCounts(target.freezeRows, 0);
  } else if (actionId === "freeze-column" && target) {
    applyFreezeCounts(0, target.freezeColumns);
  } else if (actionId === "freeze-top-row") {
    freezePanes.clearFreeze(props.tab);
    freezePanes.setFreezeRows(props.tab, 1, gridViewportHeight.value, 0);
  } else if (actionId === "freeze-first-column") {
    applyFreezeCounts(0, 1);
  } else if (actionId === "unfreeze" && hasFreeze.value) {
    freezePanes.clearFreeze(props.tab);
  }
}

function handleToolbarAction(actionId) {
  const importEvent = resolveTableImportToolbarEvent(actionId);
  if (actionId === "filter-fuzzy") setFilterMode("fuzzy");
  else if (actionId === "filter-continuous") setFilterMode("continuous");
  else if (actionId === "filter-exact") setFilterMode("exact");
  else if (actionId.startsWith("freeze-") || actionId === "unfreeze") handleFreezeAction(actionId);
  else if (actionId === "replace") emit("replace");
  else if (actionId === "export-current") emit("export");
  else if (actionId === "batch-export") emit("batch-export");
  else if (importEvent) emit(importEvent);
  else if (actionId === "split-right") emit("split-pane", "right");
  else if (actionId === "split-down") emit("split-pane", "down");
  closeToolbarMenu();
}

function onTableSearchInput(event) {
  searchInputValue.value = String(event?.target?.value ?? "");
  emit('search-input', searchInputValue.value);
}

function clearTableSearch() {
  if (!searchInputValue.value) return;
  searchInputValue.value = "";
  emit('search-input', "");
  searchInputRef.value?.focus?.();
}

// ── Adaptive column width ──────────────────────────────────────────────────

const suspendPaneResize = inject("suspendGridAutoFit", null);
let resizeObserver = null;
let pendingFillOverlayRefresh = false;

function performAutoFit() {
  const tab = props.tab;
  if (!tab || !gridWrapRef.value || !props.activeColumns.length) return;
  autoFitColumnsRaf(gridWrapRef.value, tab, props.activeColumns, tabRows(tab));
}

function startColumnResize(event, tab, colName) {
  const wrap = gridWrapRef.value;
  const grip = event.currentTarget;
  const header = grip.closest("th");
  const scrollLeft = wrap?.scrollLeft || 0;
  if (!scrollLeft || !header || header.classList.contains("frozen-col")) {
    onHandleMouseDown(event, tab, colName);
    return;
  }

  const right = header.getBoundingClientRect().right - wrap.getBoundingClientRect().left;
  const gripWidth = grip.offsetWidth + 1; // Include the column's right border.
  onHandleMouseDown(event, tab, colName, (widthDelta) => {
    // Leave deliberate scrolling during a drag alone. On shrink, reveal just
    // enough of the handle to let the user grab it again.
    if (widthDelta >= 0 || wrap.scrollLeft !== scrollLeft || gridWrapRef.value !== wrap || props.tab !== tab) return;
    const minimumRight = ROW_INDEX_WIDTH + frozenColumnsWidth.value + gripWidth;
    const hidden = minimumRight - (right + widthDelta);
    if (hidden > 0) wrap.scrollLeft = Math.floor(scrollLeft - hidden);
  });
}

function restoreAutoColumnWidth(event, tab, colName) {
  const wrap = gridWrapRef.value;
  const header = event.currentTarget.closest("th");
  resetColumnWidth(tab, colName);
  autoFitColumns(wrap, tab, props.activeColumns, tabRows(tab));

  // A scrolled oversized column can disappear behind the frozen area as
  // soon as it shrinks. Keep the restored column in view.
  if (!wrap?.scrollLeft || !header || header.classList.contains("frozen-col")) return;
  const visibleLeft = wrap.getBoundingClientRect().left + ROW_INDEX_WIDTH + frozenColumnsWidth.value;
  const headerLeft = header.getBoundingClientRect().left;
  if (headerLeft < visibleLeft) wrap.scrollLeft += headerLeft - visibleLeft;
}

function setupResizeObserver() {
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = null;
  if (!gridWrapRef.value) return;
  gridViewportHeight.value = gridWrapRef.value.clientHeight;
  resizeObserver = new ResizeObserver(() => {
    const nextHeight = gridWrapRef.value?.clientHeight || 0;
    if (nextHeight !== gridViewportHeight.value) gridViewportHeight.value = nextHeight;
    if (suspendPaneResize?.value) {
      pendingFillOverlayRefresh = true;
      return;
    }
    nextTick(updateFillOverlayPosition);
  });
  resizeObserver.observe(gridWrapRef.value);
  for (const element of gridWrapRef.value.querySelectorAll(".wb-grid, .wb-grid thead")) {
    resizeObserver.observe(element);
  }
}

watch(
  () => Boolean(suspendPaneResize?.value),
  (suspended) => {
    if (suspended || !pendingFillOverlayRefresh) return;
    pendingFillOverlayRefresh = false;
    nextTick(updateFillOverlayPosition);
  },
);

watch(
  () => [props.tab?.frozenRowStart, props.tab?.frozenRowCount, gridViewportHeight.value],
  () => {
    const tab = props.tab;
    if (!tab || gridViewportHeight.value <= 0) return;
    const clamped = freezePanes.frozenRowCountOf(tab, gridViewportHeight.value);
    if (Number(tab.frozenRowCount) !== clamped) {
      const boundary = frozenRowStart.value + Number(tab.frozenRowCount || 0);
      freezePanes.setFreezeRows(tab, clamped, gridViewportHeight.value, Math.max(0, boundary - clamped));
    }
  },
);

watch(workbenchFontSignature, () => {
  nextTick(() => performAutoFit());
});

// Re-fit when columns change (new table loaded or page refreshed)
watch(
  () => [props.tab?.id, props.activeColumns.length, props.tab?.loading],
  ([tabId, colCount, loading]) => {
    if (!tabId || !colCount || loading) return;
    const state = ensureColumnWidthState(props.tab);
    if (gridWrapRef.value && state && !Object.keys(state.widths).length) {
      autoFitColumns(gridWrapRef.value, props.tab, props.activeColumns, tabRows(props.tab));
    } else nextTick(() => performAutoFit());
  },
  { flush: "pre" },
);

// Re-fit when tab switches (active tab changed)
watch(
  () => props.tab?.id,
  () => {
    endColumnResize();
    closeToolbarMenu();
    nextTick(() => {
      setupResizeObserver();
    });
  },
);

watch(
  () => [
    props.tab?.id,
    props.showFillHandle,
    props.isFilling,
    props.fillPreview,
    props.fillSourceBounds,
    props.fillPreviewDetail,
    props.fillOptions,
    props.selectedRange,
    props.virtualRange?.start,
    props.virtualRange?.end,
    props.virtualRange?.padTop,
    props.visibleRows,
    renderCellColumns.value,
    rowHeight.value,
    fieldCommentBandHeight.value,
    frozenRowStart.value,
    frozenRowCount.value,
    frozenColumnCount.value,
  ],
  () => {
    updateFillOverlayPosition();
  },
  { flush: "post" },
);

watch(() => props.isFilling, (active) => {
  if (!active) resetLocalFillDrag();
  syncGlobalFillCursor();
});

watch(() => [isFillDragging.value, props.fillModifierActive], () => {
  syncGlobalFillCursor();
});

watch(() => props.fillOptions, (value) => {
  if (!value?.canToggleMode) fillOptionsOpen.value = false;
});

onMounted(() => {
  emit('grid-ready', gridWrapRef.value);
  emit('search-ready', searchInputRef.value);
  window.addEventListener('mousemove', continueRangeSelection);
  window.addEventListener('mousemove', continueRowDragSelection);
  window.addEventListener('mousemove', continueFillDrag);
  window.addEventListener('mouseup', endRangeSelection);
  window.addEventListener('mouseup', endRowSelection);
  window.addEventListener('mouseup', endFillDrag);
  window.addEventListener('keydown', handleFillKeyEvent);
  window.addEventListener('keyup', handleFillKeyEvent);
  window.addEventListener('mousedown', handleWindowMouseDownForFillOptions);
  window.addEventListener('blur', endPointerSelections);

  // Initial auto-fit after mount
  nextTick(() => {
    performAutoFit();
    setupResizeObserver();
  });
});

onBeforeUnmount(() => {
  resetLocalFillDrag();
  syncGlobalFillCursor();
  window.removeEventListener('mousemove', continueRangeSelection);
  window.removeEventListener('mousemove', continueRowDragSelection);
  window.removeEventListener('mousemove', continueFillDrag);
  window.removeEventListener('mouseup', endRangeSelection);
  window.removeEventListener('mouseup', endRowSelection);
  window.removeEventListener('mouseup', endFillDrag);
  window.removeEventListener('keydown', handleFillKeyEvent);
  window.removeEventListener('keyup', handleFillKeyEvent);
  window.removeEventListener('mousedown', handleWindowMouseDownForFillOptions);
  window.removeEventListener('blur', endPointerSelections);
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  disposeColumnResize();
});

function handleTableContextMenu(event) {
  if (event.target?.closest?.("input, textarea, select, [contenteditable='true']")) {
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  emit('contextmenu', event);
}

function switchToHistoryView() {
  const width = Math.round(searchFieldRef.value?.getBoundingClientRect?.().width || 0);
  emit('switch-view', 'history', width);
}

</script>

<template>
  <section v-if="tab" class="wb-table-panel" :style="gridHeightStyle" @contextmenu="handleTableContextMenu">
    <header ref="tableToolbarRef" class="wb-table-toolbar">
      <div
        ref="searchFieldRef"
        class="wb-table-search-field"
        :class="{ 'has-matches': hasSearchMatches, 'is-mode-open': openToolbarMenu === 'filter', 'is-filter-active': Boolean(tab.searchFilterActive) }"
      >
        <Search class="wb-table-search-field-icon" :size="15" aria-hidden="true" />
        <input
          ref="searchInputRef"
          :value="searchInputValue"
          class="wb-table-search-field-input"
          :placeholder="t('m_ec5bc63d86be')"
          :aria-label="t('m_b5cc536d9b6a') + activeFilterModeLabel + t('m_fd047ccb2020')"
          @input="onTableSearchInput"
          @keydown.enter.prevent="emit('search-next')"
        />
        <button
          v-if="searchInputValue"
          type="button"
          class="wb-table-search-clear"
          :aria-label="t('m_ee32f25f7050')"
          :title="t('m_ee32f25f7050')"
          @mousedown.prevent
          @click="clearTableSearch"
        >
          <X :size="16" :stroke-width="2" aria-hidden="true" />
        </button>
        <button
          v-if="searchInputValue || tab.searchFilterActive"
          type="button"
          class="wb-table-search-filter-toggle"
          :class="{ 'is-active': Boolean(tab.searchFilterActive) }"
          :aria-pressed="Boolean(tab.searchFilterActive)"
          :aria-label="tab.searchFilterActive ? t('grid.filterMatchesActive') : t('grid.filterMatchesOnly')"
          :title="tab.searchFilterActive ? t('grid.filterMatchesActive') : t('grid.filterMatchesOnly')"
          @mousedown.prevent
          @click="emit('toggle-search-filter', tab, searchInputValue)"
        >
          <ListFilter :size="16" :stroke-width="2" aria-hidden="true" />
        </button>
        <div class="wb-search-aux">
          <span v-if="hasSearchMatches" class="wb-search-nav-inline" role="group" :aria-label="t('m_8ca869f0b453')">
            <button
              class="wb-search-nav-icon"
              type="button"
              :aria-label="t('m_64d57ad378df')"
              :title="t('m_64d57ad378df')"
              @click="emit('search-previous')"
            >
              <ChevronUp :size="18" :stroke-width="2" aria-hidden="true" />
            </button>
            <button
              class="wb-search-nav-icon"
              type="button"
              :aria-label="t('m_84cb6a31b9f5')"
              :title="t('m_84cb6a31b9f5')"
              @click="emit('search-next')"
            >
              <ChevronDown :size="18" :stroke-width="2" aria-hidden="true" />
            </button>
          </span>
          <span
            v-if="searchHitSummary.label"
            class="wb-search-hit-count"
            aria-live="polite"
            :title="t('m_99d286bd4d75') + searchHitSummary.label"
          >{{ searchHitSummary.label }}</span>
        </div>
        <ToolbarSplitButton
          class="wb-search-mode-control"
          :label="activeFilterModeLabel"
          :menu-label="t('m_6ff93bc2bb48')"
          primary-opens-menu
          single-trigger
          :open="openToolbarMenu === 'filter'"
          :items="filterModeItems"
          @toggle="toggleToolbarMenu('filter')"
          @close="closeToolbarMenu('filter')"
          @select="handleToolbarAction"
        />
      </div>
      <div class="wb-table-view-switch" role="tablist" :aria-label="t('tableHistory.viewSwitchAria')">
        <button
          type="button"
          role="tab"
          aria-selected="true"
          class="wb-table-view-switch-btn is-active"
        >
          <Table2 :size="13" :stroke-width="1.9" aria-hidden="true" />
          <span>{{ t('tableHistory.viewData') }}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="false"
          class="wb-table-view-switch-btn"
          @click="switchToHistoryView"
        >
          <History :size="13" :stroke-width="1.9" aria-hidden="true" />
          <span>{{ t('tableHistory.viewHistory') }}</span>
        </button>
      </div>
      <span v-if="relationChip" class="wb-relation-chip" :title="relationChip">
        <Link2 :size="11" class="wb-relation-chip-icon" aria-hidden="true" />
        <span class="wb-sort-chip-label">{{ relationChip }}</span>
        <button
          type="button"
          class="wb-sort-chip-clear"
          :aria-label="t('relations.chip.clear')"
          :title="t('relations.chip.clear')"
          @click="clearRelationChip"
        >×</button>
      </span>
      <span v-if="tab.sort" class="wb-sort-chip" :title="t('grid.sortChip', { column: tab.sort.columnName, direction: tab.sort.descending ? t('m_4b77c3546823') : t('m_ca715c0d8d83') })">
        <span class="wb-sort-chip-icon" aria-hidden="true">{{ tab.sort.descending ? '↓' : '↑' }}</span>
        <span class="wb-sort-chip-label">{{ tab.sort.columnName }}</span>
        <button type="button" class="wb-sort-chip-clear" :aria-label="t('m_cdf8bcd4bfe2')" @click="emit('apply-sort', tab, tab.sort.columnName, 'none')">×</button>
      </span>
      <span
        v-for="rule in activeColumnFilters"
        :key="`cf:${rule.column}`"
        class="wb-column-filter-chip"
        :title="formatColumnFilterChip(rule, t)"
      >
        <Filter :size="11" class="wb-column-filter-chip-icon" aria-hidden="true" />
        <span class="wb-sort-chip-label">{{ formatColumnFilterChip(rule, t) }}</span>
        <button
          type="button"
          class="wb-sort-chip-clear"
          :aria-label="t('grid.columnFilter.clearOne', { column: rule.column })"
          @click="emit('apply-column-filter', tab, rule.column, null)"
        >×</button>
      </span>
      <button
        v-if="activeColumnFilters.length >= 2"
        type="button"
        class="wb-column-filter-clear-all"
        @click="emit('clear-column-filters', tab)"
      >{{ t('grid.columnFilter.clearAll') }}</button>
      <span v-if="schemaSearchMatches.length" class="wb-schema-search-nav" role="group" :aria-label="t('m_c580b133f2e9')">
        <span>{{ schemaSearchSummary }}</span>
        <button
          class="wb-search-nav-icon"
          type="button"
          :aria-label="t('m_203b7b74375d')"
          :title="t('m_203b7b74375d')"
          @click="emit('schema-search-previous')"
        >
          <ChevronUp :size="18" :stroke-width="2" aria-hidden="true" />
        </button>
        <button
          class="wb-search-nav-icon"
          type="button"
          :aria-label="t('m_5664cc626e5c')"
          :title="t('m_5664cc626e5c')"
          @click="emit('schema-search-next')"
        >
          <ChevronDown :size="18" :stroke-width="2" aria-hidden="true" />
        </button>
      </span>
      <div class="wb-table-toolbar-actions wb-toolbar-action-group" role="group" :aria-label="t('m_e3244d705db7')">
        <ToolbarSplitButton
          class="wb-table-toolbar-secondary"
          :label="t('m_0eafcb149bcd')"
          icon="freeze"
          :menu-label="t('m_4684f4302165')"
          :active="hasFreeze"
          :open="openToolbarMenu === 'freeze'"
          :items="freezeItems"
          @primary="applyDefaultFreeze"
          @toggle="toggleToolbarMenu('freeze')"
          @close="closeToolbarMenu('freeze')"
          @select="handleToolbarAction"
        />
        <ToolbarSplitButton
          :label="t('m_76420433f22d')"
          icon="export"
          :menu-label="t('m_afa1ad958c25')"
          :open="openToolbarMenu === 'export'"
          :items="exportItems"
          :primary-disabled="busy"
          :menu-disabled="busy"
          @primary="emit('export')"
          @toggle="toggleToolbarMenu('export')"
          @close="closeToolbarMenu('export')"
          @select="handleToolbarAction"
        />
        <ToolbarSplitButton
          :label="importActions.primary.label"
          icon="import"
          :menu-label="importActions.menuLabel"
          :open="openToolbarMenu === 'import'"
          :items="importItems"
          :primary-disabled="importActions.primary.disabled"
          :menu-disabled="importItems.every((item) => item.disabled)"
          @primary="emit(resolveTableImportToolbarEvent(importActions.primary.id))"
          @toggle="toggleToolbarMenu('import')"
          @close="closeToolbarMenu('import')"
          @select="handleToolbarAction"
        />
        <ToolbarSplitButton
          class="wb-table-toolbar-tools"
          :label="t('toolbar.tools')"
          icon="tools"
          :menu-label="t('toolbar.toolsMenuLabel')"
          primary-opens-menu
          single-trigger
          open-on-hover
          :active="hasFreeze && toolbarFitLevel > 0"
          :open="openToolbarMenu === 'tools'"
          :items="toolsActionItems"
          @open="openToolbarMenuByHover('tools')"
          @toggle="toggleToolbarMenu('tools')"
          @close="closeToolbarMenu('tools')"
          @select="handleToolbarAction"
        />
      </div>
      <ToolbarSplitButton
        class="wb-toolbar-compact-overflow wb-table-toolbar-overflow"
        :label="t('m_38844b135cf7')"
        icon="more"
        :menu-label="t('m_e3244d705db7')"
        primary-opens-menu
        single-trigger
        open-on-hover
        :active="hasFreeze"
        :open="openToolbarMenu === 'compact'"
        :items="compactActionItems"
        @open="openToolbarMenuByHover('compact')"
        @toggle="toggleToolbarMenu('compact')"
        @close="closeToolbarMenu('compact')"
        @select="handleToolbarAction"
      />
    </header>

    <div ref="gridShellRef" class="wb-grid-shell">
      <div
        ref="gridWrapRef"
        class="wb-grid-wrap"
        :class="{ 'is-selecting-range': isSelectingRange || isCellDragging, 'is-filling': isFilling || isFillDragging, 'is-fill-previewing': Boolean(fillPreviewOverlay), 'is-fill-toggle': (isFilling || isFillDragging) && fillModifierActive, 'is-row-selecting': isRowDragging, 'is-reordering-columns': columnReorderSurface.reordering, 'is-column-drop-forbidden': columnReorderSurface.forbidden }"
        role="grid"
        :aria-rowcount="gridAriaRowCount"
        :aria-colcount="1 + activeColumns.length"
        :aria-activedescendant="activeCellDomId || undefined"
        :aria-busy="tab.loading || tab.loadingMore || busy"
        aria-multiselectable="true"
        :aria-label="t('grid.dataGridLabel', { table: tab.tableName || t('m_187288e87023') })"
        tabindex="0"
        @scroll.passive="onGridWrapScroll"
        @keydown="emit('keydown', $event)"
        @compositionstart.capture="emit('cell-input-start', $event)"
        @input.capture="emit('cell-input-start', $event)"
        @paste="emit('paste', $event)"
      >
        <div v-if="tab.loading" class="wb-grid-loading">
          <span class="wb-grid-loading-spinner" aria-hidden="true"></span>
          <span class="wb-grid-loading-text">{{ t('m_4927a53bcc88') }}</span>
        </div>
        <div v-else-if="tab.loadError" class="wb-grid-error">
          <svg class="wb-grid-error-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p class="wb-grid-error-title">{{ t('m_d1d044826a45') }}</p>
          <p class="wb-grid-error-detail">{{ tab.loadError }}</p>
          <button type="button" class="wb-grid-error-retry" @click="emit('retry-load', tab)">{{ t('m_b8784c8dd563') }}</button>
        </div>
        <table class="wb-grid" :data-grid-id="gridInstanceId">
        <thead>
          <tr class="wb-grid-column-header-row">
            <th
              class="wb-row-index wb-row-index-corner"
              role="columnheader"
              :class="{ 'row-selected': loadedRowCount + visibleInsertRowCount > 0 && tab.selectedRowKeys.size === loadedRowCount + visibleInsertRowCount }"
              :title="t('m_b82fe8d0afb1')"
              @click="emit('toggle-all-rows', tab)"
            ></th>
            <template v-for="columnMeta in renderCellColumns" :key="columnMeta.name">
<th v-if="columnMeta.kind === 'spacer'" class="wb-col-spacer" aria-hidden="true" :style="columnMeta.cellStyle"></th>
<th v-else
            :style="mergeStyles(colStyle(tab, columnMeta.name), frozenColumnStyle(columnMeta.columnIndex))"
            :data-column-index="columnMeta.columnIndex"
                :aria-colindex="columnMeta.columnIndex + 2"
            :data-column-name="columnMeta.name"
            role="columnheader"
            :class="{
              'schema-search-match': isSchemaSearchColumn(columnMeta.column, columnMeta.name),
              'schema-search-active': isActiveSchemaSearchColumn(columnMeta.column, columnMeta.name),
              'col-selected': isColumnSelected(tab, columnMeta.columnIndex),
              'col-active': isActiveColumn(columnMeta.name),

              'is-numeric-col': columnMeta.isNumeric,
              'frozen-col': columnMeta.columnIndex < frozenColumnCount,
              'frozen-col-edge': isLastFrozenColumn(columnMeta.columnIndex),
              'is-column-dragging': columnReorderSurface.reordering && columnReorder.sourceName === columnMeta.name,
            }"
            @pointerdown.left="onColumnHeaderPointerDown(tab, columnMeta, $event)"
            @contextmenu.prevent.stop="emit('contextmenu', $event)"
            >
              <span
                class="wb-th-text"
                :title="columnMeta.comment ? `${columnMeta.name} · ${columnMeta.comment}` : columnMeta.name"
              >{{ columnMeta.name }}</span>
              <ColumnSortMenu
                :column="columnMeta.name"
                :sort="tab.sort"
                :column-filter="columnFilterFor(columnMeta.name)"
                :fetch-distinct-values="fetchDistinctValues"
                @apply-sort="emit('apply-sort', tab, columnMeta.name, $event)"
                @apply-column-filter="emit('apply-column-filter', tab, columnMeta.name, $event)"
              />
              <span class="wb-col-resize-track">
                <span
                  class="wb-col-resize"
                  role="separator"
                  aria-orientation="vertical"
                  tabindex="0"
                  :aria-label="t('grid.resizeColumnAria', { column: columnMeta.name })"
                  :aria-valuemin="COL_RESIZE_MIN_WIDTH"
                  :aria-valuenow="Math.round(getColumnWidth(tab, columnMeta.name) || MIN_COL_WIDTH)"
                  :aria-valuetext="t('grid.pixels', { value: Math.round(getColumnWidth(tab, columnMeta.name) || MIN_COL_WIDTH) })"
                  :title="t('grid.resizeColumnTitle', { column: columnMeta.name })"
                  @mousedown.left="startColumnResize($event, tab, columnMeta.name)"
                  @keydown="onHandleKeyDown($event, tab, columnMeta.name)"
                  @dblclick.stop.prevent="restoreAutoColumnWidth($event, tab, columnMeta.name)"
                ></span>
              </span>
            </th>
</template>
          </tr>
          <tr
            class="wb-field-comments-row"
            :class="{ 'is-collapsed': !fieldCommentsExpanded }"
            :style="{ '--wb-field-comment-row-height': `${fieldCommentBandHeight}px` }"
          >
            <th class="wb-row-index wb-field-comments-toggle-cell" role="columnheader">
              <button
                type="button"
                class="wb-field-comments-toggle"
                :title="fieldCommentsExpanded ? t('m_384f890e67df') : t('m_e83e4573c434')"
                :aria-label="fieldCommentsExpanded ? t('m_384f890e67df') : t('m_e83e4573c434')"
                :aria-expanded="fieldCommentsExpanded ? 'true' : 'false'"
                @click.stop="toggleFieldComments"
              >
                <MessageSquareText :size="12" :stroke-width="2" aria-hidden="true" />
                <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline :points="fieldCommentsExpanded ? '2,5.5 4.5,3 7,5.5' : '2,3.5 4.5,6 7,3.5'" />
                </svg>
              </button>
              <span
                class="wb-row-resize-handle wb-field-comments-resize-handle"
                role="separator"
                aria-orientation="horizontal"
                :aria-label="t('m_377b68b9f7f3')"
                :title="t('m_a699e7805a43')"
                @pointerdown="startRowResize($event, 'fieldComment')"
                @dblclick.stop.prevent="resetRowHeight('fieldComment')"
              ></span>
            </th>
            <template v-for="columnMeta in renderCellColumns" :key="columnMeta.name">
<th v-if="columnMeta.kind === 'spacer'" class="wb-col-spacer" aria-hidden="true" :style="columnMeta.cellStyle"></th>
<th v-else
              class="wb-field-comment-cell"
              role="columnheader"
              :class="{
                'is-empty': !columnMeta.comment,
                'is-selected': isFieldCommentSelected(columnMeta.name),
                'frozen-col': columnMeta.columnIndex < frozenColumnCount,
                'frozen-col-edge': isLastFrozenColumn(columnMeta.columnIndex),
              }"
              :style="mergeStyles(colStyle(tab, columnMeta.name), frozenColumnStyle(columnMeta.columnIndex))"
              :title="columnMeta.comment || t('m_d631217b36b5')"
              @click.stop="selectFieldComment(columnMeta)"
            >
              <TableMentionText
                v-if="fieldCommentsExpanded"
                class="wb-field-comment-text"
                :style="{ '--wb-field-comment-lines': fieldCommentLineCount }"
                :text="columnMeta.comment || '—'"
                :tables="tableMentionIndex"
                @open="openMentionedTable"
              />
              <span v-else class="wb-field-comment-collapsed-mark" aria-hidden="true"></span>
            </th>
</template>
          </tr>
        </thead>
        <tbody @mousedown="onTbodyMouseDown" @mouseover="onTbodyMouseOver" @mouseup="endRangeSelection" @click="onTbodyClick" @dblclick="onTbodyDblClick">
          <!-- 越过冻结点后，冻结行段独立于虚拟窗口渲染。
               向上滚回冻结点之前时会释放，原始行重新进入 visibleRows。 -->
          <template v-if="frozenRowCount > 0">
            <GridDataRow
              v-for="{ row, originalIndex, frozenIndex, rowKey } in frozenRows"
              :key="`frozen-${rowKey}`"
              :frozen-style="frozenRowStyles[frozenIndex]"
              :last-frozen-row="isLastFrozenRow(originalIndex)"
              v-bind="rowModel(row, rowKey, originalIndex, dataRowVisualIndex(originalIndex), tab.rowStore?.rowVersion(originalIndex))"
              :columns="renderCellColumns"
              :tab-id="tab.id"
              :frozen-column-count="frozenColumnCount"
              :has-active-cell-search="hasActiveCellSearch"
              :display-text="displayText"
              :highlight-html="highlightHtml"
              :is-search-match="isSearchMatch"
              :cell-dom-id="gridCellDomId"
              :table-index="tableMentionIndex"
              @open-table="openMentionedTable"
              @row-select-start="(row, index, event) => onRowSelectStart(tab, row, index, event)"
              @toggle-row-select="(row, event) => emit('toggle-row-select', tab, row, event)"
              @row-contextmenu="(event, row, index) => emit('row-contextmenu', event, tab, row, index)"
              @row-resize-start="startRowResize($event, 'data')"
              @row-resize-reset="resetRowHeight('data')"
              @edit-input="emit('edit-input', $event)"
              @cell-blur="emit('cell-blur')"
              @finish-edit="emit('finish-edit')"
              @cancel-edit="emit('cancel-edit')"
              @tab-edit="emit('tab-edit', $event)"
            />
          </template>
          <tr v-if="virtualRange.padTop > 0" aria-hidden="true" class="wb-virtual-spacer">
            <td :style="{ height: virtualRange.padTop + 'px' }" :colspan="1 + renderCellColumns.length"></td>
          </tr>
          <template v-for="{ row, originalIndex, rowKey, visualIndex, rowVersion } in visibleRowsWithVisualIndex" :key="rowKey">
            <tr
              v-for="(insertRow, insertRowIndex) in anchoredInsertRowsAt(originalIndex)"
              :key="insertRow.id"
              class="wb-insert-row"
              :data-row-selection-index="anchoredInsertVisualIndex(originalIndex, insertRowIndex)"
              :class="{
                'is-unsaved': true,
                'is-saving': isInsertRowSaving(tab, insertRow.id),
                'row-selected': tab.selectedRowKeys.has(insertRowKey(tab, insertRow)),
                'row-range-active': isRowInSelectedRange(tab, anchoredInsertVisualIndex(originalIndex, insertRowIndex)),
              }"
            >
              <td
                class="wb-row-index wb-row-insert-marker wb-row-header"
                role="rowheader"
                :class="{ 'row-selected': tab.selectedRowKeys.has(insertRowKey(tab, insertRow)) }"
                :title="t('m_055443fb169a')"
                :aria-label="t('m_6146d3f24846')"
                @mousedown.left.stop.prevent="onRowSelectStart(tab, insertRowObject(insertRow), anchoredInsertVisualIndex(originalIndex, insertRowIndex), $event)"
                @click.stop="emit('insert-row-select', tab, insertRow.id, $event)"
                @contextmenu.prevent.stop="emit('row-contextmenu', $event, tab, insertRowObject(insertRow), anchoredInsertVisualIndex(originalIndex, insertRowIndex))"
              >
                <span class="wb-insert-row-number">{{ anchoredInsertVisualIndex(originalIndex, insertRowIndex) + 1 }}</span>
                <span class="wb-insert-row-actions">
                  <button
                    type="button"
                    :disabled="isInsertRowSaving(tab, insertRow.id)"
                    :aria-label="t('m_647ca7fb1e5c')"
                    :title="t('m_647ca7fb1e5c')"
                    @click.stop="emit('save-insert-row', tab, insertRow.id)"
                  >
                    <LoaderCircle v-if="isInsertRowSaving(tab, insertRow.id)" class="is-spinning" :size="13" aria-hidden="true" />
                    <Check v-else :size="13" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    :disabled="isInsertRowSaving(tab, insertRow.id)"
                    :aria-label="t('m_ce86ba72a588')"
                    :title="t('m_ce86ba72a588')"
                    @click.stop="emit('cancel-insert-row', tab, insertRow.id)"
                  ><X :size="13" aria-hidden="true" /></button>
                </span>
                <span
                  class="wb-row-resize-handle"
                  role="separator"
                  aria-orientation="horizontal"
                  :aria-label="t('m_50393189c2e8')"
                  :title="t('m_aff65da3daa5')"
                  @pointerdown="startRowResize($event, 'data')"
                  @dblclick.stop.prevent="resetRowHeight('data')"
                ></span>
              </td>
              <template v-for="columnMeta in renderCellColumns" :key="columnMeta.name">
<td v-if="columnMeta.kind === 'spacer'" class="wb-col-spacer" aria-hidden="true" :style="columnMeta.cellStyle"></td>
<td v-else
                :style="mergeStyles(colStyle(tab, columnMeta.name), frozenColumnStyle(columnMeta.columnIndex))"
                :data-column-index="columnMeta.columnIndex"
                :aria-colindex="columnMeta.columnIndex + 2"
                :data-row-key="insertRowKey(tab, insertRow)"
                :data-visual-row-index="anchoredInsertVisualIndex(originalIndex, insertRowIndex)"
                :data-column-name="columnMeta.name"
                :id="gridCellDomId(tab.id, insertRowKey(tab, insertRow), columnMeta.name)"
                role="gridcell"
                :aria-selected="isCellInSelectedRange(tab, insertRowKey(tab, insertRow), columnMeta.name, anchoredInsertVisualIndex(originalIndex, insertRowIndex), columnMeta.columnIndex)"
                :aria-invalid="Boolean(getCellError(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name))"
                :aria-busy="isInsertRowSaving(tab, insertRow.id)"
                :title="getCellError(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name) || ''"
                :class="{
                  pending: isCellPending(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name),
                  error: getCellError(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name),
                  selected: selectedCell?.rowKey === insertRowKey(tab, insertRow) && selectedCell?.column === columnMeta.name && selectedCell?.tabId === tab.id,
                  'col-active': isActiveColumn(columnMeta.name),

                  'is-numeric-col': columnMeta.isNumeric,
                  editing: editingCell?.rowKey === insertRowKey(tab, insertRow) && editingCell?.column === columnMeta.name,
                  'insert-selected': selectedInsertCell?.tabId === tab.id && selectedInsertCell?.rowId === insertRow.id && selectedInsertCell?.columnIndex === columnMeta.columnIndex,
                  ...cellRangeClasses(tab, insertRowKey(tab, insertRow), columnMeta.name, anchoredInsertVisualIndex(originalIndex, insertRowIndex), columnMeta.columnIndex),
                  'frozen-col': columnMeta.columnIndex < frozenColumnCount,
                  'frozen-col-edge': isLastFrozenColumn(columnMeta.columnIndex),
                }"
                @mousedown.left="onCellRangeStart(tab, insertRowObject(insertRow), columnMeta.name, anchoredInsertVisualIndex(originalIndex, insertRowIndex), columnMeta.columnIndex, $event)"
                @mouseenter="emit('cell-enter', tab, insertRowObject(insertRow), columnMeta.name, anchoredInsertVisualIndex(originalIndex, insertRowIndex), columnMeta.columnIndex)"
                @mouseup="endRangeSelection"
                @click="emit('cell-click', tab, insertRowObject(insertRow), columnMeta.name, anchoredInsertVisualIndex(originalIndex, insertRowIndex), columnMeta.columnIndex)"
                @dblclick="emit('cell-dblclick', tab, insertRowObject(insertRow), columnMeta.name, anchoredInsertVisualIndex(originalIndex, insertRowIndex), columnMeta.columnIndex)"
              >
                <input
                  v-if="insertEditorVisible(insertRow, columnMeta.name)"
                  v-ime-value="insertCellEditing(insertRow, columnMeta.name) ? editDraft : ''"
                  data-ime-editor
                  autocomplete="off"
                  spellcheck="false"
                  tabindex="-1"
                  :class="{ 'wb-cell-ime-hold': !insertCellEditing(insertRow, columnMeta.name) }"
                  :data-insert-row-id="insertRow.id"
                  :data-insert-column-index="columnMeta.columnIndex"
                  :data-row-index="anchoredInsertVisualIndex(originalIndex, insertRowIndex)"
                  :data-column-index="columnMeta.columnIndex"
                :aria-colindex="columnMeta.columnIndex + 2"
                  :disabled="isInsertRowSaving(tab, insertRow.id)"
                  :placeholder="isPrimaryKeyColumn(columnMeta.column, columnMeta.name) ? 'auto' : ''"
                  @focus="emit('insert-focus', tab, insertRow.id, columnMeta.columnIndex)"
                  @input="onCellEditorInput"
                  @compositionstart="onCellEditorCompositionStart"
                  @compositionend="onCellEditorCompositionEnd"
                  @paste="emit('insert-paste', tab, insertRow.id, columnMeta.columnIndex, $event)"
                  @blur="emit('cell-blur')"
                  @dblclick.stop
                  @keydown="onCellEditorKeydown"
                />
                <TableMentionText
                  v-if="!insertCellEditing(insertRow, columnMeta.name)"
                  class="wb-cell-text"
                  :text="insertRowCellValueByName(tab, insertRow, columnMeta.name)"
                  :tables="columnMeta.isNumeric ? null : tableMentionIndex"
                  @open="openMentionedTable"
                />
              </td>
</template>
            </tr>
            <GridDataRow
              v-bind="rowModel(row, rowKey, originalIndex, visualIndex, rowVersion)"
              :columns="renderCellColumns"
              :tab-id="tab.id"
              :frozen-column-count="frozenColumnCount"
              :has-active-cell-search="hasActiveCellSearch"
              :display-text="displayText"
              :highlight-html="highlightHtml"
              :is-search-match="isSearchMatch"
              :cell-dom-id="gridCellDomId"
              :table-index="tableMentionIndex"
              @open-table="openMentionedTable"
              @row-select-start="(row, index, event) => onRowSelectStart(tab, row, index, event)"
              @toggle-row-select="(row, event) => emit('toggle-row-select', tab, row, event)"
              @row-contextmenu="(event, row, index) => emit('row-contextmenu', event, tab, row, index)"
              @row-resize-start="startRowResize($event, 'data')"
              @row-resize-reset="resetRowHeight('data')"
              @edit-input="emit('edit-input', $event)"
              @cell-blur="emit('cell-blur')"
              @finish-edit="emit('finish-edit')"
              @cancel-edit="emit('cancel-edit')"
              @tab-edit="emit('tab-edit', $event)"
            />
          </template>
          <tr v-if="virtualBottomSpacerHeight > 0" aria-hidden="true" class="wb-virtual-spacer">
            <td :style="{ height: virtualBottomSpacerHeight + 'px' }" :colspan="1 + renderCellColumns.length"></td>
          </tr>
          <!-- 0 行空状态：表加载成功但无数据 -->
          <tr v-if="!tab.loading && !tab.loadError && loadedRowCount === 0 && !hasInsertRows" class="wb-grid-empty-row">
            <td :colspan="1 + renderCellColumns.length" class="wb-grid-empty-cell">
              <span>{{ tab.filter || tab.sort ? t('m_c8e843a2735a') : t('m_497c85690c4c') }}</span>
              <button
                v-if="!tab.filter && !tab.sort && !activeTabReadOnly"
                type="button"
                class="wb-grid-empty-action"
                @click.stop="emit('insert-first-row', tab)"
              >
                <Plus :size="14" aria-hidden="true" /> {{ t('m_189a33254417') }} </button>
            </td>
          </tr>
          <tr
            v-for="(insertRow, insertRowIndex) in trailingInsertRows"
            :key="insertRow.id"
            class="wb-insert-row"
            :data-row-selection-index="trailingInsertVisualIndex(insertRowIndex)"
            :class="{
              'is-unsaved': true,
              'is-saving': isInsertRowSaving(tab, insertRow.id),
              'row-selected': tab.selectedRowKeys.has(insertRowKey(tab, insertRow)),
              'row-range-active': isRowInSelectedRange(tab, trailingInsertVisualIndex(insertRowIndex)),
            }"
          >
            <td
              class="wb-row-index wb-row-insert-marker wb-row-header"
              role="rowheader"
              :class="{ 'row-selected': tab.selectedRowKeys.has(insertRowKey(tab, insertRow)) }"
              :title="t('m_055443fb169a')"
              :aria-label="t('m_6146d3f24846')"
              @mousedown.left.stop.prevent="onRowSelectStart(tab, insertRowObject(insertRow), trailingInsertVisualIndex(insertRowIndex), $event)"
              @click.stop="emit('insert-row-select', tab, insertRow.id, $event)"
              @contextmenu.prevent.stop="emit('row-contextmenu', $event, tab, insertRowObject(insertRow), trailingInsertVisualIndex(insertRowIndex))"
            >
              <span class="wb-insert-row-number">{{ trailingInsertVisualIndex(insertRowIndex) + 1 }}</span>
              <span class="wb-insert-row-actions">
                <button
                  type="button"
                  :disabled="isInsertRowSaving(tab, insertRow.id)"
                  :aria-label="t('m_647ca7fb1e5c')"
                  :title="t('m_647ca7fb1e5c')"
                  @click.stop="emit('save-insert-row', tab, insertRow.id)"
                >
                  <LoaderCircle v-if="isInsertRowSaving(tab, insertRow.id)" class="is-spinning" :size="13" aria-hidden="true" />
                  <Check v-else :size="13" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  :disabled="isInsertRowSaving(tab, insertRow.id)"
                  :aria-label="t('m_ce86ba72a588')"
                  :title="t('m_ce86ba72a588')"
                  @click.stop="emit('cancel-insert-row', tab, insertRow.id)"
                ><X :size="13" aria-hidden="true" /></button>
              </span>
              <span
                class="wb-row-resize-handle"
                role="separator"
                aria-orientation="horizontal"
                :aria-label="t('m_50393189c2e8')"
                :title="t('m_aff65da3daa5')"
                @pointerdown="startRowResize($event, 'data')"
                @dblclick.stop.prevent="resetRowHeight('data')"
              ></span>
            </td>
            <template v-for="columnMeta in renderCellColumns" :key="columnMeta.name">
<td v-if="columnMeta.kind === 'spacer'" class="wb-col-spacer" aria-hidden="true" :style="columnMeta.cellStyle"></td>
<td v-else
              :style="mergeStyles(colStyle(tab, columnMeta.name), frozenColumnStyle(columnMeta.columnIndex))"
              :data-column-index="columnMeta.columnIndex"
                :aria-colindex="columnMeta.columnIndex + 2"
              :data-row-key="insertRowKey(tab, insertRow)"
              :data-visual-row-index="trailingInsertVisualIndex(insertRowIndex)"
              :data-column-name="columnMeta.name"
              :id="gridCellDomId(tab.id, insertRowKey(tab, insertRow), columnMeta.name)"
              role="gridcell"
              :aria-selected="isCellInSelectedRange(tab, insertRowKey(tab, insertRow), columnMeta.name, trailingInsertVisualIndex(insertRowIndex), columnMeta.columnIndex)"
              :aria-invalid="Boolean(getCellError(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name))"
              :aria-busy="isInsertRowSaving(tab, insertRow.id)"
              :title="getCellError(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name) || ''"
              :class="{
                pending: isCellPending(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name),
                error: getCellError(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name),
                selected: selectedCell?.rowKey === insertRowKey(tab, insertRow) && selectedCell?.column === columnMeta.name && selectedCell?.tabId === tab.id,
                'col-active': isActiveColumn(columnMeta.name),

                'is-numeric-col': columnMeta.isNumeric,
                editing: editingCell?.rowKey === insertRowKey(tab, insertRow) && editingCell?.column === columnMeta.name,
                'insert-selected': selectedInsertCell?.tabId === tab.id && selectedInsertCell?.rowId === insertRow.id && selectedInsertCell?.columnIndex === columnMeta.columnIndex,
                ...cellRangeClasses(tab, insertRowKey(tab, insertRow), columnMeta.name, trailingInsertVisualIndex(insertRowIndex), columnMeta.columnIndex),
                'frozen-col': columnMeta.columnIndex < frozenColumnCount,
                'frozen-col-edge': isLastFrozenColumn(columnMeta.columnIndex),
              }"
              @mousedown.left="onCellRangeStart(tab, insertRowObject(insertRow), columnMeta.name, trailingInsertVisualIndex(insertRowIndex), columnMeta.columnIndex, $event)"
              @mouseenter="emit('cell-enter', tab, insertRowObject(insertRow), columnMeta.name, trailingInsertVisualIndex(insertRowIndex), columnMeta.columnIndex)"
              @mouseup="endRangeSelection"
              @click="emit('cell-click', tab, insertRowObject(insertRow), columnMeta.name, trailingInsertVisualIndex(insertRowIndex), columnMeta.columnIndex)"
              @dblclick="emit('cell-dblclick', tab, insertRowObject(insertRow), columnMeta.name, trailingInsertVisualIndex(insertRowIndex), columnMeta.columnIndex)"
            >
              <input
                v-if="insertEditorVisible(insertRow, columnMeta.name)"
                v-ime-value="insertCellEditing(insertRow, columnMeta.name) ? editDraft : ''"
                data-ime-editor
                autocomplete="off"
                spellcheck="false"
                tabindex="-1"
                :class="{ 'wb-cell-ime-hold': !insertCellEditing(insertRow, columnMeta.name) }"
                :data-insert-row-id="insertRow.id"
                :data-insert-column-index="columnMeta.columnIndex"
                :data-row-index="trailingInsertVisualIndex(insertRowIndex)"
                :data-column-index="columnMeta.columnIndex"
                :aria-colindex="columnMeta.columnIndex + 2"
                :disabled="isInsertRowSaving(tab, insertRow.id)"
                :placeholder="isPrimaryKeyColumn(columnMeta.column, columnMeta.name) ? 'auto' : ''"
                @focus="emit('insert-focus', tab, insertRow.id, columnMeta.columnIndex)"
                @input="onCellEditorInput"
                @compositionstart="onCellEditorCompositionStart"
                @compositionend="onCellEditorCompositionEnd"
                @paste="emit('insert-paste', tab, insertRow.id, columnMeta.columnIndex, $event)"
                @blur="emit('cell-blur')"
                @dblclick.stop
                @keydown="onCellEditorKeydown"
              />
              <TableMentionText
                  v-if="!insertCellEditing(insertRow, columnMeta.name)"
                  class="wb-cell-text"
                  :text="insertRowCellValueByName(tab, insertRow, columnMeta.name)"
                  :tables="columnMeta.isNumeric ? null : tableMentionIndex"
                  @open="openMentionedTable"
                />
            </td>
</template>
          </tr>
          <tr v-if="showAppendRowAction" class="wb-grid-append-row">
            <td :colspan="1 + renderCellColumns.length" class="wb-grid-append-cell">
              <button
                type="button"
                class="wb-grid-append-action"
                :title="t('m_e0f80cb19890')"
                :aria-label="t('m_e0f80cb19890')"
                @click.stop="emit('append-row', tab)"
              >
                <Plus :size="14" aria-hidden="true" />
                <span>{{ t('m_e712bb66258e') }}</span>
              </button>
            </td>
          </tr>
          <tr v-if="tab.loadingMore" class="wb-grid-loadmore-row">
            <td :colspan="1 + renderCellColumns.length" class="wb-grid-loadmore-cell">
              <span class="wb-grid-loadmore-spinner" aria-hidden="true"></span>
              <span>{{ t('m_58be224a15bb') }}</span>
            </td>
          </tr>
          <tr v-else-if="!tab.fullyLoaded && loadedRowCount > 0" aria-hidden="true" class="wb-grid-loadmore-row">
            <td :colspan="1 + renderCellColumns.length" class="wb-grid-loadmore-cell">
              <span>&nbsp;</span>
            </td>
          </tr>
        </tbody>
        </table>
        <div class="wb-grid-boundary-clearance" aria-hidden="true"></div>
      </div>
      <div class="wb-grid-boundary-float">
        <Transition name="wb-boundary-pop">
          <button
            v-if="showBoundaryJumpTop"
            type="button"
            class="wb-grid-boundary-pill wb-grid-boundary-pill--top"
            :disabled="Boolean(tab.boundaryLoading) || tab.loading || !tab.sessionId"
            :title="t('m_5fc2469ddd0b')"
            :aria-label="t('m_5fc2469ddd0b')"
            @click="emit('jump-boundary', 'top')"
          >
            <LoaderCircle v-if="tab.boundaryLoading === 'top'" class="is-spinning" :size="13" aria-hidden="true" />
            <ArrowUpToLine v-else :size="13" aria-hidden="true" />
            <span>{{ t('m_a18bb798f70e') }}</span>
          </button>
        </Transition>
        <Transition name="wb-boundary-pop">
          <button
            v-if="showBoundaryJumpBottom"
            type="button"
            class="wb-grid-boundary-pill wb-grid-boundary-pill--bottom"
            :disabled="Boolean(tab.boundaryLoading) || tab.loading || !tab.sessionId"
            :title="t('m_51857aae27ea')"
            :aria-label="t('m_51857aae27ea')"
            @click="emit('jump-boundary', 'bottom')"
          >
            <LoaderCircle v-if="tab.boundaryLoading === 'bottom'" class="is-spinning" :size="13" aria-hidden="true" />
            <ArrowDownToLine v-else :size="13" aria-hidden="true" />
            <span>{{ t('m_cea06f008053') }}</span>
          </button>
        </Transition>
      </div>
      <div
        v-if="columnReorderSurface.showDropLine"
        class="wb-column-drop-line"
        :style="{
          left: `${columnReorder.drop.left}px`,
          top: `${columnReorder.drop.top}px`,
          height: `${columnReorder.drop.height}px`,
        }"
        aria-hidden="true"
      ></div>
      <div
        v-if="columnReorderSurface.showGhost"
        class="wb-column-drag-ghost"
        :style="{
          left: `${columnReorder.ghost.x}px`,
          top: `${columnReorder.ghost.y}px`,
          width: `${columnReorder.ghost.width}px`,
        }"
        aria-hidden="true"
      >{{ columnReorder.ghost.label }}</div>
      <div
        v-if="fillPreviewOverlay"
        class="wb-fill-preview-clip"
        :style="fillPreviewOverlay.clipStyle"
        aria-hidden="true"
      >
        <div
          v-if="fillPreviewOverlay.targetStyle"
          class="wb-fill-target-wash"
          :style="fillPreviewOverlay.targetStyle"
        ></div>
        <div
          v-if="fillPreviewOverlay.sourceStyle"
          class="wb-fill-source-frame"
          :class="fillPreviewOverlay.sourceClasses"
          :style="fillPreviewOverlay.sourceStyle"
        ></div>
        <div
          v-if="fillPreviewOverlay.previewStyle"
          class="wb-fill-preview-frame"
          :class="fillPreviewOverlay.previewClasses"
          :style="fillPreviewOverlay.previewStyle"
        ></div>
      </div>
      <div
        v-if="fillOverlayStyle && (showFillHandle || isFillDragging || fillOptions?.canToggleMode)"
        class="wb-fill-overlay"
        :style="fillOverlayStyle"
      >
        <button
          v-if="showFillHandle || isFillDragging"
          type="button"
          class="wb-fill-handle"
          :class="{ 'is-fill-hidden': isFillHandleHidden }"
          :aria-label="t('m_83dfa4b49abe')"
          :title="tPlatform('grid.fillHandleHint')"
          @mousedown.left.stop.prevent="onFillHandleMouseDown"
          @dblclick.left.stop.prevent="onFillHandleDoubleClick"
        ></button>
        <div
          v-if="fillOptions?.canToggleMode && !isFilling && !isFillDragging"
          class="wb-fill-options"
          :class="{ 'is-flip-left': fillOverlayPlacement.flipLeft, 'is-flip-up': fillOverlayPlacement.flipUp, 'is-open': fillOptionsOpen }"
        >
          <button
            type="button"
            class="wb-fill-options-trigger"
            :aria-expanded="fillOptionsOpen"
            aria-haspopup="menu"
            :aria-label="t('m_062fc75e44bd')"
            :title="t('m_062fc75e44bd')"
            @mousedown.stop.prevent
            @click.stop="toggleFillOptionsMenu"
          >
            <svg class="wb-fill-options-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <rect x="1" y="1" width="4.5" height="4.5" rx="0.6" stroke="currentColor" stroke-width="1.1" />
              <rect x="6.5" y="1" width="4.5" height="4.5" rx="0.6" stroke="currentColor" stroke-width="1.1" opacity="0.55" />
              <rect x="1" y="6.5" width="4.5" height="4.5" rx="0.6" stroke="currentColor" stroke-width="1.1" opacity="0.55" />
              <rect x="6.5" y="6.5" width="4.5" height="4.5" rx="0.6" fill="var(--wb-accent)" />
            </svg>
            <svg class="wb-fill-options-caret" width="7" height="5" viewBox="0 0 7 5" fill="none" aria-hidden="true">
              <path d="M1 1.25L3.5 3.75L6 1.25" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <menu
            v-if="fillOptionsOpen"
            ref="fillOptionsMenuRef"
            class="wb-fill-options-menu"
            role="menu"
            @mousedown.stop
            @keydown="onFillOptionsMenuKeydown"
          >
            <button
              type="button"
              role="menuitemradio"
              :aria-checked="fillOptions.appliedMode === 'copy'"
              class="wb-fill-options-item"
              :class="{ active: fillOptions.appliedMode === 'copy' }"
              @click.stop="chooseFillOption('copy')"
            >
              <Check v-if="fillOptions.appliedMode === 'copy'" :size="12" class="wb-fill-options-check" aria-hidden="true" />
              <span v-else class="wb-fill-options-check-spacer" aria-hidden="true"></span>
              <span>{{ t('m_59d8cc2898d8') }}</span>
            </button>
            <button
              type="button"
              role="menuitemradio"
              :aria-checked="fillOptions.appliedMode === 'series'"
              class="wb-fill-options-item"
              :class="{ active: fillOptions.appliedMode === 'series' }"
              @click.stop="chooseFillOption('series')"
            >
              <Check v-if="fillOptions.appliedMode === 'series'" :size="12" class="wb-fill-options-check" aria-hidden="true" />
              <span v-else class="wb-fill-options-check-spacer" aria-hidden="true"></span>
              <span>{{ t('m_8d4a33b55299') }}</span>
            </button>
          </menu>
        </div>
      </div>
      <div
        v-if="isFilling && fillPreviewDetail && fillPreviewTipStyle"
        ref="fillPreviewTipRef"
        class="wb-fill-preview-tip"
        :style="fillPreviewTipStyle"
        aria-live="polite"
      >
        <span
          class="wb-fill-preview-value"
          :class="{ 'is-empty': fillPreviewDetail.displayValue === '' }"
        >{{ fillPreviewDetail.displayValue === '' ? '""' : fillPreviewDetail.displayValue }}</span>
        <span
          class="wb-fill-preview-mode"
          :class="{ 'is-series': fillPreviewDetail.mode === 'series' }"
        >
          {{ fillPreviewDetail.mode === 'series' ? t('grid.fillModeSeries') : t('grid.fillModeCopy') }}
        </span>
      </div>
    </div>

  </section>

  <section v-else class="wb-empty"> {{ t('m_5f6d133c282b') }} </section>
</template>
