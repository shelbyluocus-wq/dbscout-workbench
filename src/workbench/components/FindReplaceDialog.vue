<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronDown, ChevronUp, X } from "lucide-vue-next";
import { useEscClose } from "../composables/useEscClose.js";
import { useConfirm } from "../composables/useConfirm.js";
import { gridSelectionCount } from "../utils/gridCellSelection.js";
import { findSearchRanges, highlightSearchRanges, contiguousSearchPreview } from "../utils/searchMatch.js";

const props = defineProps({
  // focusedPaneState：当前焦点 pane 的能力注册表（选区、定位、替换等）。
  paneState: { type: Object, required: true },
  invokeWorkbench: { type: Function, required: true },
  // "find" | "replace"：打开时停在哪一页（Ctrl+F / Ctrl+H）。
  initialTab: { type: String, default: "find" },
});

const emit = defineEmits(["close", "replaced-all"]);

const isBusy = ref(false);
const { confirm } = useConfirm();

const activeTab = ref(props.initialTab === "replace" ? "replace" : "find");
watch(() => props.initialTab, (tab) => {
  activeTab.value = tab === "replace" ? "replace" : "find";
});

const findInputRef = ref(null);
const query = ref("");
const replacement = ref("");
const caseSensitive = ref(false);
const feedback = ref({ kind: "", text: "" });

const findText = computed(() => query.value.trim());
const hasTab = computed(() => Boolean(props.paneState.activeDataTab));
const activeTableIdentity = computed(() => {
  const tab = props.paneState.activeDataTab;
  return tab ? `${tab.id || ""}\x1f${tab.sessionId || ""}` : "";
});

// Excel 语义：多选单元格时只在选区内查找替换，否则范围为整张表（含未加载页）。
const selectionRange = computed(() => {
  const range = props.paneState.selectedRange;
  const tab = props.paneState.activeDataTab;
  if (!range || !tab || range.tabId !== tab.id) return null;
  return gridSelectionCount(range) > 1 ? range : null;
});
const selectionCellCount = computed(() => (selectionRange.value ? gridSelectionCount(selectionRange.value) : 0));
const scopeIsSelection = computed(() => Boolean(selectionRange.value));

/* ── 命中结果列表 ── */
const matches = ref([]);
const activeIndex = ref(-1);
const listLoading = ref(false);
const listError = ref("");
const totalCells = ref(0);
const totalOccurrences = ref(0);
const truncated = ref(false);
const listCompletedSeq = ref(0);
let listTimer = null;
let listSeq = 0;
let listRequest = null;
let listRequestSeq = 0;
// Passive typing is debounced because an unscoped lookup scans the whole table.
// Enter and the navigation buttons bypass this delay through refreshListNow().
const TABLE_LIST_DEBOUNCE_MS = 350;

const columnLabelByName = computed(() => {
  const map = new Map();
  for (const column of props.paneState.activeColumns || []) {
    const name = String(column?.column_name ?? column?.columnName ?? "");
    if (!name) continue;
    const comment = String(column?.column_comment ?? column?.columnComment ?? "").trim();
    map.set(name, comment || name);
  }
  return map;
});

// 「列」一列显示字段名，字段备注放在悬浮提示里。
function columnLabel(name) {
  return name;
}

function columnTooltip(name) {
  const comment = columnLabelByName.value.get(name) || "";
  return comment && comment !== name ? `${name}（${comment}）` : name;
}

/* ── 结果列表列宽（可拖拽调整，值列默认占满剩余空间）── */
const resultsRef = ref(null);
const identityColWidth = ref(110);
const nameColWidth = ref(130);
const valueColWidth = ref(null); // null = 占满剩余空间
const COUNT_COL_WIDTH = 44;
const COL_GAP = 10;

const gridTemplateStyle = computed(() => ({
  gridTemplateColumns: `${identityColWidth.value}px ${nameColWidth.value}px ${valueColWidth.value == null ? "minmax(0, 1fr)" : `${valueColWidth.value}px`} max-content`,
}));

function currentValueColumnWidth() {
  if (valueColWidth.value != null) return valueColWidth.value;
  const container = resultsRef.value?.clientWidth || 480;
  return Math.max(120, container - identityColWidth.value - nameColWidth.value - COUNT_COL_WIDTH - COL_GAP * 3 - 28);
}

function startColumnResize(which, event) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const startWidth = which === "identity"
    ? identityColWidth.value
    : which === "name"
      ? nameColWidth.value
      : currentValueColumnWidth();
  let dragged = false;
  const onMove = (moveEvent) => {
    const next = Math.max(48, Math.round(startWidth + moveEvent.clientX - startX));
    if (Math.abs(moveEvent.clientX - startX) > 2) dragged = true;
    if (which === "identity") identityColWidth.value = next;
    else if (which === "name") nameColWidth.value = next;
    else valueColWidth.value = next;
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    // 拖拽结束时若鼠标已移出弹窗，随后的 click 会落在遮罩上触发关闭——吞掉它。
    if (dragged) {
      suppressOverlayClick = true;
      setTimeout(() => { suppressOverlayClick = false; }, 0);
    }
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function identityLabel(rowIdentity) {
  const entries = Object.entries(rowIdentity || {});
  if (!entries.length) return "（新增行）";
  return entries.map(([key, value]) => `${key}=${value ?? "NULL"}`).join(" + ");
}

function matchPreviewHtml(match) {
  const preview = contiguousSearchPreview(match.value, findText.value, 72);
  return highlightSearchRanges(preview, findSearchRanges(preview, findText.value, { caseSensitive: caseSensitive.value }));
}

const activeMatch = computed(() => (activeIndex.value >= 0 ? matches.value[activeIndex.value] || null : null));

const listSummary = computed(() => {
  if (!findText.value) return "";
  if (!totalCells.value) return "没有匹配内容";
  const base = scopeIsSelection.value
    ? `选区内命中 ${totalCells.value} 个单元格（共 ${totalOccurrences.value} 处）`
    : `共 ${totalOccurrences.value} 处，涉及 ${totalCells.value} 个单元格`;
  return truncated.value ? `${base}，仅显示前 ${matches.value.length} 条` : base;
});

function applySelectionList(seq = listSeq) {
  const items = props.paneState.listSelectionMatches?.({
    query: findText.value,
    caseSensitive: caseSensitive.value,
  }) || [];
  matches.value = items;
  totalCells.value = items.length;
  totalOccurrences.value = items.reduce((sum, item) => sum + item.occurrences, 0);
  truncated.value = false;
  listError.value = "";
  if (seq === listSeq) listCompletedSeq.value = seq;
}

async function applyTableList(seq) {
  const tab = props.paneState.activeDataTab;
  const tableIdentity = activeTableIdentity.value;
  if (!tab?.sessionId) {
    if (seq === listSeq) {
      listCompletedSeq.value = seq;
      listLoading.value = false;
    }
    return;
  }
  listLoading.value = true;
  listError.value = "";
  try {
    const result = await props.invokeWorkbench("find_in_table", {
      request: {
        sessionId: tab.sessionId,
        query: findText.value,
        caseSensitive: caseSensitive.value,
        limit: 500,
      },
    });
    if (seq !== listSeq || tableIdentity !== activeTableIdentity.value) return;
    matches.value = Array.isArray(result?.matches) ? result.matches : [];
    totalCells.value = Number(result?.totalCells) || 0;
    totalOccurrences.value = Number(result?.totalOccurrences) || 0;
    truncated.value = Boolean(result?.truncated);
  } catch (error) {
    if (seq !== listSeq || tableIdentity !== activeTableIdentity.value) return;
    matches.value = [];
    totalCells.value = 0;
    totalOccurrences.value = 0;
    truncated.value = false;
    listError.value = String(error?.message || error);
  } finally {
    if (seq === listSeq) {
      listCompletedSeq.value = seq;
      listLoading.value = false;
    }
  }
}

function startTableList(seq) {
  const request = applyTableList(seq);
  listRequest = request;
  listRequestSeq = seq;
  const release = () => {
    if (listRequest === request) {
      listRequest = null;
      listRequestSeq = 0;
    }
  };
  request.then(release, release);
  return request;
}

function scheduleListRefresh() {
  activeIndex.value = -1;
  if (listTimer) {
    clearTimeout(listTimer);
    listTimer = null;
  }
  const seq = ++listSeq;
  if (!findText.value || !hasTab.value) {
    matches.value = [];
    totalCells.value = 0;
    totalOccurrences.value = 0;
    truncated.value = false;
    listError.value = "";
    listLoading.value = false;
    listCompletedSeq.value = seq;
    return;
  }
  if (scopeIsSelection.value) {
    applySelectionList(seq);
    return;
  }
  listLoading.value = true;
  listTimer = setTimeout(() => {
    listTimer = null;
    void startTableList(seq);
  }, TABLE_LIST_DEBOUNCE_MS);
}

watch(
  [
    findText,
    caseSensitive,
    scopeIsSelection,
    selectionCellCount,
    // 选区内容只在选区范围内影响列表；整表范围内跳转产生的选区变化（单元格
    // 收拢）不能触发列表刷新，否则当前命中下标会被重置、替换永远只导航。
    () => (scopeIsSelection.value ? props.paneState.selectedRange : null),
  ],
  scheduleListRefresh,
  { immediate: true, flush: "sync" },
);

watch(activeTableIdentity, () => {
  matches.value = [];
  activeIndex.value = -1;
  totalCells.value = 0;
  totalOccurrences.value = 0;
  truncated.value = false;
  listError.value = "";
  setFeedback("", "");
  scheduleListRefresh();
}, { flush: "sync" });

onBeforeUnmount(() => {
  if (listTimer) clearTimeout(listTimer);
});

/* ── 导航与跳转 ── */
const canRequestNavigation = computed(() => hasTab.value && Boolean(findText.value) && !isBusy.value);
const canNavigate = computed(() => (
  canRequestNavigation.value
  && (listCompletedSeq.value !== listSeq || matches.value.length > 0)
));

async function jumpToMatch(index) {
  const match = matches.value[index];
  if (!match) return;
  activeIndex.value = index;
  await props.paneState.locateListMatch?.(match);
  await keepActiveMatchVisible();
}

async function goToNext() {
  if (!canRequestNavigation.value || !(await refreshListNow()) || !matches.value.length) return;
  await jumpToMatch((activeIndex.value + 1) % matches.value.length);
}

async function goToPrevious() {
  if (!canRequestNavigation.value || !(await refreshListNow()) || !matches.value.length) return;
  await jumpToMatch((activeIndex.value - 1 + matches.value.length) % matches.value.length);
}

function setFeedback(kind, text) {
  feedback.value = { kind, text };
}

/* ── 替换 ── */
const canReplace = computed(() => hasTab.value && Boolean(findText.value) && !isBusy.value);

async function replaceCurrent() {
  if (!canReplace.value) return;
  if (!activeMatch.value) {
    await goToNext();
    return;
  }
  const index = activeIndex.value;
  const match = activeMatch.value;
  isBusy.value = true;
  setFeedback("", "");
  try {
    const result = await props.paneState.replaceListMatch?.({
      match,
      query: findText.value,
      replacement: replacement.value,
      caseSensitive: caseSensitive.value,
    });
    if (!result?.ok) {
      setFeedback("error", result?.reason || "替换失败");
      return;
    }
    if (result.replaced > 0) {
      // 局部刷新列表项：剩余命中归零则移除，否则更新值与处数。
      if (scopeIsSelection.value) {
        applySelectionList();
      } else {
        const stillMatches = findSearchRanges(result.newValue, findText.value, { caseSensitive: caseSensitive.value }).length;
        if (stillMatches > 0) {
          matches.value[index] = { ...match, value: result.newValue, occurrences: stillMatches };
          totalOccurrences.value -= result.replaced - stillMatches;
        } else {
          matches.value.splice(index, 1);
          totalCells.value -= 1;
          totalOccurrences.value -= result.replaced;
        }
      }
    }
    // 前进到下一个命中（列表缩短后同一下标即下一条）。
    if (matches.value.length) {
      await jumpToMatch(Math.min(index, matches.value.length - 1));
    } else {
      activeIndex.value = -1;
    }
  } finally {
    isBusy.value = false;
  }
}

async function replaceAllInSelection() {
  const result = await props.paneState.replaceCellsInSelection?.({
    query: findText.value,
    replacement: replacement.value,
    caseSensitive: caseSensitive.value,
  });
  if (!result) return;
  if (!result.ok) {
    setFeedback("error", result.reason || "选区替换失败");
  } else if (result.cells > 0) {
    setFeedback("success", `已在选区内替换 ${result.cells} 个单元格（共 ${result.replaced} 处），可按 Ctrl+Z 撤销`);
  } else {
    setFeedback("", "选区内没有匹配的内容");
  }
  scheduleListRefresh();
}

async function replaceAllInTable() {
  const tab = props.paneState.activeDataTab;
  if (!tab?.sessionId) {
    setFeedback("error", "当前表会话不可用");
    return;
  }
  const request = {
    sessionId: tab.sessionId,
    query: findText.value,
    replacement: replacement.value,
    caseSensitive: caseSensitive.value,
    dryRun: true,
  };
  const preview = await props.invokeWorkbench("replace_in_table", { request });
  const cells = Number(preview?.replacedCells) || 0;
  const rows = Number(preview?.replacedRows) || 0;
  if (!cells) {
    setFeedback("", "整张表中没有匹配的内容");
    return;
  }
  const confirmed = await confirm({
    title: "全部替换",
    message:
      `将在整张表中把「${findText.value}」替换为「${replacement.value}」。\n` +
      `共 ${cells} 处，涉及 ${rows} 行（包括未加载的行）。\n\n` +
      `该操作会记录审计日志，可通过备份/回滚功能恢复，也可按 Ctrl+Z 撤销。`,
    confirmText: "全部替换",
    cancelText: "取消",
  });
  if (!confirmed) return;
  const result = await props.invokeWorkbench("replace_in_table", { request: { ...request, dryRun: false } });
  const replacedCellsCount = Number(result?.replacedCells) || 0;
  const replacedRowsCount = Number(result?.replacedRows) || 0;
  setFeedback("success", `已替换 ${replacedCellsCount} 处，涉及 ${replacedRowsCount} 行，可按 Ctrl+Z 撤销`);
  scheduleListRefresh();
  emit("replaced-all", {
    tab,
    patches: Array.isArray(result?.patches) ? result.patches : [],
    replacedCells: replacedCellsCount,
    replacedRows: replacedRowsCount,
  });
}

async function replaceAll() {
  if (!canReplace.value) return;
  isBusy.value = true;
  setFeedback("", "");
  try {
    if (scopeIsSelection.value) await replaceAllInSelection();
    else await replaceAllInTable();
  } catch (error) {
    setFeedback("error", String(error?.message || error));
  } finally {
    isBusy.value = false;
  }
}

function switchTab(tab) {
  activeTab.value = tab;
  nextTick(() => findInputRef.value?.focus());
}

/* ── 非模态窗口拖动与缩放 ── */
const dialogRef = ref(null);
useEscClose(() => true, () => emit("close"), () => isBusy.value, { dialogRef, modal: false });
const dialogLeft = ref(0);
const dialogTop = ref(0);
const dialogWidth = ref(460);
const dialogHeight = ref(null); // null = 高度随内容自适应；拖拽缩放后固定
const positionReady = ref(false);
const VIEWPORT_INSET = 8;
const MIN_DIALOG_WIDTH = 440;

const dialogStyle = computed(() => ({
  left: `${dialogLeft.value}px`,
  top: `${dialogTop.value}px`,
  width: `${dialogWidth.value}px`,
  visibility: positionReady.value ? "visible" : "hidden",
  ...(dialogHeight.value != null ? { height: `${dialogHeight.value}px` } : {}),
}));

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

// 停靠在当前表格的右上角，而不是盖在表格正中；命中单元格被挡住时自动换到其它角。
const GRID_CORNER_INSET = 12;

function focusedGridShellRect() {
  const shell = document.querySelector(".wb-workbench-pane.is-focused .wb-grid-shell")
    || document.querySelector(".wb-grid-shell");
  const rect = shell?.getBoundingClientRect?.();
  return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

function activeMatchCellRect() {
  const wrap = document.querySelector(".wb-workbench-pane.is-focused .wb-grid-wrap")
    || document.querySelector(".wb-grid-wrap");
  const cellId = wrap?.getAttribute?.("aria-activedescendant");
  return (cellId && document.getElementById(cellId)?.getBoundingClientRect()) || null;
}

function rectsOverlap(a, b, gap = 0) {
  return a.left < b.right + gap && a.right + gap > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top;
}

function gridCornerPositions(height) {
  const shell = focusedGridShellRect();
  if (!shell) return [];
  const width = dialogWidth.value;
  const right = shell.right - width - GRID_CORNER_INSET;
  const bottom = shell.bottom - height - GRID_CORNER_INSET;
  const left = shell.left + GRID_CORNER_INSET;
  const top = shell.top + GRID_CORNER_INSET;
  return [
    { left: right, top },
    { left: right, top: bottom },
    { left, top },
    { left, top: bottom },
  ].map((position) => ({
    left: clamp(position.left, VIEWPORT_INSET, window.innerWidth - width - VIEWPORT_INSET),
    top: clamp(position.top, VIEWPORT_INSET, window.innerHeight - height - VIEWPORT_INSET),
  }));
}

function nextAnimationFrame() {
  return new Promise((resolve) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => resolve()) : setTimeout(resolve, 0)));
}

async function keepActiveMatchVisible() {
  await nextTick();
  await nextAnimationFrame();
  await nextAnimationFrame();
  const cell = activeMatchCellRect();
  const dialog = dialogRef.value?.getBoundingClientRect?.();
  if (!cell || !dialog || !rectsOverlap(cell, dialog)) return;
  const free = gridCornerPositions(dialog.height).find((position) => !rectsOverlap(cell, {
    left: position.left,
    top: position.top,
    right: position.left + dialog.width,
    bottom: position.top + dialog.height,
  }));
  if (!free) return;
  // 换位后的落点也要真正露出命中单元格，且与其保持一点距离
  if (rectsOverlap(cell, { left: free.left, top: free.top, right: free.left + dialog.width, bottom: free.top + dialog.height }, 6)) return;
  dialogLeft.value = free.left;
  dialogTop.value = free.top;
}

function initializeDialogPosition() {
  const viewportWidth = window.innerWidth;
  dialogWidth.value = Math.min(dialogWidth.value, Math.max(MIN_DIALOG_WIDTH, viewportWidth - VIEWPORT_INSET * 2));
  const docked = gridCornerPositions(dialogRef.value?.offsetHeight || 0)[0];
  dialogLeft.value = docked?.left ?? Math.max(VIEWPORT_INSET, Math.round((viewportWidth - dialogWidth.value) / 2));
  dialogTop.value = docked?.top ?? Math.max(VIEWPORT_INSET, Math.round(window.innerHeight * 0.15));
  positionReady.value = true;
}

function keepDialogInViewport() {
  const height = dialogRef.value?.offsetHeight || 0;
  dialogLeft.value = clamp(dialogLeft.value, VIEWPORT_INSET, window.innerWidth - dialogWidth.value - VIEWPORT_INSET);
  dialogTop.value = clamp(dialogTop.value, VIEWPORT_INSET, window.innerHeight - height - VIEWPORT_INSET);
}

function measureNaturalDialogHeight() {
  const dialog = dialogRef.value;
  if (!dialog) return 0;
  const previousHeight = dialog.style.height;
  const hadMeasuringClass = dialog.classList.contains("is-measuring-minimum");
  dialog.style.height = "auto";
  dialog.classList.add("is-measuring-minimum");
  const naturalHeight = Math.ceil(dialog.getBoundingClientRect().height);
  dialog.style.height = previousHeight;
  if (!hadMeasuringClass) dialog.classList.remove("is-measuring-minimum");
  return naturalHeight;
}

function ensureDialogFitsContent() {
  if (dialogHeight.value == null) return;
  const maximumHeight = window.innerHeight - dialogTop.value - VIEWPORT_INSET;
  const minimumHeight = Math.min(measureNaturalDialogHeight(), maximumHeight);
  if (dialogHeight.value < minimumHeight) dialogHeight.value = minimumHeight;
}

function startDragMove(event) {
  if (event.target.closest(".wb-dialog-close")) return;
  event.preventDefault();
  const startX = event.clientX;
  const startY = event.clientY;
  const baseLeft = dialogLeft.value;
  const baseTop = dialogTop.value;
  const height = dialogRef.value?.offsetHeight || 0;
  const onMove = (moveEvent) => {
    dialogLeft.value = clamp(
      baseLeft + moveEvent.clientX - startX,
      VIEWPORT_INSET,
      window.innerWidth - dialogWidth.value - VIEWPORT_INSET,
    );
    dialogTop.value = clamp(
      baseTop + moveEvent.clientY - startY,
      VIEWPORT_INSET,
      window.innerHeight - height - VIEWPORT_INSET,
    );
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function startDialogResize(event) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const startY = event.clientY;
  const startRect = dialogRef.value?.getBoundingClientRect();
  const anchorLeft = Math.round(startRect?.left ?? dialogLeft.value);
  const anchorTop = Math.round(startRect?.top ?? dialogTop.value);
  dialogLeft.value = anchorLeft;
  dialogTop.value = anchorTop;
  const startWidth = dialogWidth.value;
  const startHeight = dialogHeight.value ?? startRect?.height ?? 0;
  const maximumHeight = window.innerHeight - anchorTop - VIEWPORT_INSET;
  const minimumHeight = Math.min(measureNaturalDialogHeight() || startHeight, maximumHeight);
  const onMove = (moveEvent) => {
    dialogWidth.value = clamp(
      Math.round(startWidth + moveEvent.clientX - startX),
      MIN_DIALOG_WIDTH,
      window.innerWidth - anchorLeft - VIEWPORT_INSET,
    );
    dialogHeight.value = clamp(
      Math.round(startHeight + moveEvent.clientY - startY),
      minimumHeight,
      maximumHeight,
    );
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/* ── 查找全部：展开/收起结果列表（默认紧凑不显示）── */
const listExpanded = ref(false);

watch([activeTab, listExpanded, () => feedback.value.text], () => {
  if (dialogHeight.value != null) nextTick(ensureDialogFitsContent);
});

async function refreshListNow() {
  if (listTimer) {
    clearTimeout(listTimer);
    listTimer = null;
  }
  if (!findText.value || !hasTab.value) return false;
  const seq = listSeq;
  if (listCompletedSeq.value === seq) return true;
  if (scopeIsSelection.value) {
    applySelectionList(seq);
  } else if (listRequest && listRequestSeq === seq) {
    await listRequest;
  } else {
    await startTableList(seq);
  }
  return seq === listSeq && listCompletedSeq.value === seq;
}

function toggleFindAll() {
  listExpanded.value = !listExpanded.value;
  if (listExpanded.value) {
    // 值列在展开时固化为像素宽度：保证表头与各行严格同宽（否则表头按自身
    // 内容计算 1fr 会比数据行窄，横向滚动时右侧露出空白）。
    if (valueColWidth.value == null) {
      nextTick(() => {
        if (valueColWidth.value == null) valueColWidth.value = currentValueColumnWidth();
      });
    }
    void refreshListNow();
  }
}

onMounted(() => {
  initializeDialogPosition();
  window.addEventListener("resize", keepDialogInViewport);
  nextTick(() => findInputRef.value?.focus());
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", keepDialogInViewport);
});
</script>

<template>
  <div class="wb-dialog-overlay wb-find-replace-overlay">
    <section
      ref="dialogRef"
      class="wb-dialog wb-find-replace-dialog"
      :class="{ 'has-custom-height': dialogHeight != null }"
      :style="dialogStyle"
      role="dialog"
      aria-labelledby="wb-find-replace-title"
      tabindex="-1"
    >
      <header class="wb-find-replace-header" @mousedown="startDragMove">
        <strong id="wb-find-replace-title" class="wb-find-replace-title">{{ t('m_644df97760a6') }}</strong>
        <button
          type="button"
          class="wb-dialog-close"
          :aria-label="t('m_edbac2c6e327')"
          :disabled="isBusy"
          @click="emit('close')"
        >
          <X :size="22" :stroke-width="2" aria-hidden="true" />
        </button>
      </header>

      <nav class="wb-find-replace-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          class="wb-find-replace-tab"
          :class="{ 'is-active': activeTab === 'find' }"
          :aria-selected="activeTab === 'find'"
          @click="switchTab('find')"
        > {{ t('m_3003318e729a') }} </button>
        <button
          type="button"
          role="tab"
          class="wb-find-replace-tab"
          :class="{ 'is-active': activeTab === 'replace' }"
          :aria-selected="activeTab === 'replace'"
          @click="switchTab('replace')"
        > {{ t('m_131b13aa2659') }} </button>
      </nav>

      <div class="wb-dialog-body wb-find-replace-body">
        <label class="wb-dialog-field wb-replace-field">
          <span>{{ t('m_bf603c449cd8') }}</span>
          <span class="wb-find-input-row">
            <input
              ref="findInputRef"
              v-model="query"
              type="text"
              autocomplete="off"
              spellcheck="false"
              :disabled="isBusy"
              @keydown.enter.exact.prevent="goToNext"
              @keydown.shift.enter.prevent="goToPrevious"
            />
            <button
              type="button"
              class="wb-find-nav-button"
              :aria-label="t('m_bd4b9718f1f0')"
              :title="`${t('m_bd4b9718f1f0')}（Shift+Enter）`"
              :disabled="!canNavigate"
              @click.prevent="goToPrevious"
            >
              <ChevronUp :size="16" :stroke-width="2" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="wb-find-nav-button"
              :aria-label="t('m_a898d7c3d78c')"
              :title="`${t('m_a898d7c3d78c')}（Enter）`"
              :disabled="!canNavigate"
              @click.prevent="goToNext"
            >
              <ChevronDown :size="16" :stroke-width="2" aria-hidden="true" />
            </button>
          </span>
        </label>
        <label v-if="activeTab === 'replace'" class="wb-dialog-field wb-replace-field">
          <span>{{ t('m_7d37f059645b') }}</span>
          <input
            v-model="replacement"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :disabled="isBusy"
            @keydown.enter.prevent="replaceCurrent"
          />
        </label>

        <div class="wb-find-replace-options">
          <label class="wb-replace-option">
            <input v-model="caseSensitive" type="checkbox" :disabled="isBusy" />
            <span>{{ t('m_8c7e3447ec67') }}</span>
          </label>
          <span class="wb-find-replace-scope-text" :class="{ 'is-selection': scopeIsSelection }">
            <template v-if="scopeIsSelection">{{ t('m_e0efb68c4a25') }} {{ selectionCellCount }} {{ t('m_5e6d00b1ff75') }}</template>
            <template v-else>{{ t('m_21c41420e543') }}</template>
          </span>
        </div>

        <template v-if="listExpanded">
          <div ref="resultsRef" class="wb-find-results" :class="{ 'is-loading': listLoading }">
            <div class="wb-find-results-head" :style="gridTemplateStyle">
              <span class="wb-find-results-head-cell"> {{ t('m_58e4aa4164f7') }} <i class="wb-find-results-col-resize" @mousedown="startColumnResize('identity', $event)" />
              </span>
              <span class="wb-find-results-head-cell"> {{ t('m_c06d21404eee') }} <i class="wb-find-results-col-resize" @mousedown="startColumnResize('name', $event)" />
              </span>
              <span class="wb-find-results-head-cell"> {{ t('m_cda1d55c5231') }} <i class="wb-find-results-col-resize" @mousedown="startColumnResize('value', $event)" />
              </span>
              <span />
            </div>
            <div v-if="listError" class="wb-find-results-empty">{{ listError }}</div>
            <div v-else-if="findText && !matches.length && !listLoading" class="wb-find-results-empty"> {{ t('m_06e53a170b95') }} </div>
            <div v-else-if="!findText" class="wb-find-results-empty">{{ t('m_76cd1a40f209') }}</div>
            <template v-else>
              <button
                v-for="(match, index) in matches"
                :key="`${identityLabel(match.rowIdentity)}|${match.columnName}|${index}`"
                type="button"
                class="wb-find-result-row"
                :class="{ 'is-active': index === activeIndex }"
                :style="gridTemplateStyle"
                @click="jumpToMatch(index)"
              >
                <span class="wb-find-result-identity" :title="identityLabel(match.rowIdentity)">
                  {{ identityLabel(match.rowIdentity) }}
                </span>
                <span class="wb-find-result-column" :title="columnTooltip(match.columnName)">{{ columnLabel(match.columnName) }}</span>
                <!-- eslint-disable-next-line vue/no-v-html -->
                <span class="wb-find-result-value" v-html="matchPreviewHtml(match)" />
                <span v-if="match.occurrences > 1" class="wb-find-result-count">×{{ match.occurrences }}</span>
              </button>
            </template>
          </div>
          <p v-if="listSummary" class="wb-find-results-summary">{{ listSummary }}</p>
        </template>

        <p v-if="feedback.text" class="wb-replace-feedback" :class="`is-${feedback.kind || 'info'}`">
          {{ feedback.text }}
        </p>
      </div>

      <footer class="wb-dialog-actions wb-replace-footer">
        <div class="wb-replace-footer-left">
          <button
            type="button"
            class="wb-find-all-button"
            :class="{ 'is-expanded': listExpanded }"
            :disabled="isBusy || !findText"
            @click="toggleFindAll"
          > {{ t('m_dde41ecd61f7') }} <component :is="listExpanded ? ChevronUp : ChevronDown" class="wb-find-all-caret" :size="14" aria-hidden="true" />
          </button>
        </div>
        <div v-if="activeTab === 'replace'" class="wb-replace-footer-right">
          <button type="button" :disabled="!canReplace" @click="replaceCurrent">{{ t('m_131b13aa2659') }}</button>
          <button
            type="button"
            class="wb-dialog-primary wb-replace-all-button"
            :disabled="!canReplace"
            @click="replaceAll"
          > {{ t('m_2357445f30da') }} </button>
        </div>
      </footer>
      <span
        class="wb-find-replace-resize-handle"
        aria-hidden="true"
        @mousedown="startDialogResize"
      />
    </section>
  </div>
</template>
