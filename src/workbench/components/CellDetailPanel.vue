<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Check, ChevronDown, ChevronUp, Copy, Link2, ListOrdered, SlidersHorizontal, Tag } from "lucide-vue-next";
import { highlightDetailValue, isDetailJson, resolveDetailCopyText, resolveDetailEditorView } from "../utils/cellDisplay.js";
import { buildCellStructuredPreview } from "../utils/cellStructuredPreview.js";
import { resolveCellEnumPreview, resolveCellSlotPreview } from "../utils/commentDirectives.js";
import { createCellDetailVisibility } from "../cellDetailVisibility.js";
import { useCellDetailAmbient } from "../composables/useCellDetailAmbient.js";
import { useShortcuts } from "../composables/useShortcuts.js";
import { formatShortcutForPlatform } from "../utils/desktopPlatform.js";

const props = defineProps({
  selectedCell: { type: Object, default: null },
  cellContext: { type: Object, default: null },
  rowSummary: { type: String, default: "" },
  textDraft: { type: String, default: "" },
  identityRemap: { type: Object, default: null },
  readOnly: { type: Boolean, default: false },
  isNull: { type: Boolean, default: false },
  selectionStats: { type: Object, default: null },
  cellRelations: { type: Array, default: () => [] },
});

const emit = defineEmits([
  "update:textDraft",
  "save-text-panel",
  "commit-detail-draft",
  "detail-contextmenu",
  "exit-detail",
  "open-relation-target",
  "edit-column-meaning",
]);

const DETAIL_DEFAULT_HEIGHT = 160;
const DETAIL_MIN_HEIGHT = 96;
// Releasing the resize drag at/under this height collapses the panel to its
// slim title bar; expanding later restores the default height.
const COLLAPSE_SNAP_THRESHOLD = 24;
const COMPACT_HEIGHT = 72;
const HANDLE_HEIGHT = 7;
const KEYBOARD_STEP = 12;

const rootRef = ref(null);
const detailInputRef = ref(null);
const detailHighlightsRef = ref(null);
// sourceDraft 是将要保存的原文；viewDraft 只用于展示（JSON 格式化预览）。
const sourceDraft = ref("");
const viewDraft = ref("");
const isDraftDirty = ref(false);
const loadedCellKey = ref("");
const lastIdentityRemapId = ref(0);
// 结构化记录当前 textarea 草稿所属的单元格。失焦时如果 selectedCell 已被
// 切换到别的单元格（点击网格换行），仍能按原单元格提交，避免草稿丢失或写错行。
const loadedCell = ref(null);
const detailHeight = ref(DETAIL_DEFAULT_HEIGHT);
const isResizing = ref(false);
// 收起/展开与 JSON 格式化偏好（含 localStorage 持久化）由独立模块持有，
// 组件只消费 state 与 toggle/notify 方法。
const visibility = createCellDetailVisibility();
const { ambientStyle } = useCellDetailAmbient();
const { get: getShortcut, matchesBinding } = useShortcuts();
let removeDragListeners = null;

const selectedCellKey = computed(() =>
  props.selectedCell ? [props.selectedCell.tabId, props.selectedCell.rowKey, props.selectedCell.column, props.selectedCell.kind || "data"].join("") : "",
);
const isFieldComment = computed(() => props.selectedCell?.kind === "fieldComment");
const detailPlaceholder = computed(() => {
  if (isFieldComment.value) return "字段备注（只读）";
  const saveShortcut = formatShortcutForPlatform(getShortcut("save"));
  const saveHint = saveShortcut ? `失焦或 ${saveShortcut} 保存` : "失焦保存";
  return `选中单元格后在这里查看或编辑长文本（${saveHint}）`;
});
const isJsonDetail = computed(() => isDetailJson(sourceDraft.value));
const cardView = ref(false);
const jsonPretty = computed(() => !cardView.value && visibility.state.jsonPretty);
const jsonRaw = computed(() => !cardView.value && !visibility.state.jsonPretty);
const structuredPreview = computed(() => (
  props.selectedCell && !isFieldComment.value
    ? buildCellStructuredPreview(sourceDraft.value, props.cellRelations)
    : { kind: "none", canCardView: false, cards: [], items: [], inlineTargets: [] }
));
const showCardView = computed(() => Boolean(cardView.value && structuredPreview.value.canCardView && !isPanelCollapsed.value));
const cellTargetComment = computed(() => (
  props.selectedCell && !isFieldComment.value ? String(props.cellContext?.comment || "").trim() : ""
));
const cellEnumItems = computed(() => (
  props.selectedCell && !isFieldComment.value && !props.isNull
    ? resolveCellEnumPreview(sourceDraft.value, cellTargetComment.value)
    : []
));
const cellSlotItems = computed(() => (
  props.selectedCell && !isFieldComment.value && !props.isNull
    ? resolveCellSlotPreview(sourceDraft.value, cellTargetComment.value)
    : []
));
const collapsedEnumItems = computed(() => cellEnumItems.value.slice(0, 2));
const collapsedSlotItems = computed(() => {
  const remaining = Math.max(0, 2 - collapsedEnumItems.value.length);
  return cellSlotItems.value.slice(0, remaining);
});
const collapsedInlineTargets = computed(() => {
  const remaining = Math.max(0, 2 - collapsedEnumItems.value.length - collapsedSlotItems.value.length);
  return structuredPreview.value.inlineTargets.slice(0, remaining);
});
const collapsedInlineExtraCount = computed(() => Math.max(
  0,
  cellEnumItems.value.length + cellSlotItems.value.length + structuredPreview.value.inlineTargets.length - 2,
));
const hasInlineMeaningChips = computed(() => (
  cellEnumItems.value.length > 0 || cellSlotItems.value.length > 0 || structuredPreview.value.inlineTargets.length > 0
));
const canEditColumnMeaning = computed(() => Boolean(
  props.selectedCell && !isFieldComment.value && (props.cellContext?.column || props.selectedCell?.column),
));
const detailFormatting = computed(() => highlightDetailValue(viewDraft.value));
const hasInlineFormatting = computed(() => props.selectedCell && detailFormatting.value.kind !== "text");
const detailPanelStyle = computed(() => ({ height: `${detailHeight.value}px` }));
const hasSelectedCell = computed(() => Boolean(props.selectedCell));
const isPanelCollapsed = computed(() => visibility.state.collapsed || !hasSelectedCell.value);
const showJsonFormatToggle = computed(() => Boolean(props.selectedCell && isJsonDetail.value && !isPanelCollapsed.value));
const isCompact = computed(() => detailHeight.value <= COMPACT_HEIGHT);
const cellTargetLabel = computed(() => {
  if (!props.selectedCell) return "";
  const ctx = props.cellContext;
  if (ctx?.isFieldComment || isFieldComment.value) {
    const col = ctx?.column || props.selectedCell.column || "";
    return col ? t("cellDetail.fieldCommentTarget", { column: col }) : "";
  }
  const col = ctx?.column || props.selectedCell.column || "";
  if (!col) return "";
  return ctx?.rowNumber ? t("cellDetail.rowColumn", { row: ctx.rowNumber, column: col }) : col;
});
const copyFeedback = ref(false);
let copyFeedbackTimer = 0;
const copiedStatKey = ref("");
let copiedStatTimer = 0;
const canCopyDetail = computed(() => Boolean(
  props.selectedCell && !props.isNull && String(sourceDraft.value ?? "").length > 0,
));
// 收起时内容区高度动画到 0，把垂直空间平滑还给数据网格；展开恢复为
// 拖柄 + 编辑器高度。动画时长/缓动见 CSS 里的 pane-collapse token。
const contentStyle = computed(() => (
  isPanelCollapsed.value
    ? { height: "0px", opacity: "0" }
    : { height: `${HANDLE_HEIGHT + detailHeight.value}px`, opacity: "1" }
));
const toggleLabel = computed(() => (isPanelCollapsed.value ? t("cellDetail.expand") : t("cellDetail.collapse")));
const selectionStatItems = computed(() => (
  (props.selectionStats?.count || 0) >= 2 && Array.isArray(props.selectionStats?.items)
    ? props.selectionStats.items
    : []
));
const selectionRangeItems = computed(() => (
  selectionStatItems.value.length > 0 && Array.isArray(props.selectionStats?.rangeItems)
    ? props.selectionStats.rangeItems
    : []
));

async function copyStatValue(item) {
  const text = String(item?.fullText || item?.text || "");
  if (!text) return;
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (typeof clipboard?.writeText === "function") {
      await clipboard.writeText(text);
    } else if (globalThis.document?.createElement) {
      const area = globalThis.document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      globalThis.document.body.appendChild(area);
      area.select();
      globalThis.document.execCommand("copy");
      globalThis.document.body.removeChild(area);
    }
    copiedStatKey.value = item.key;
    if (copiedStatTimer) clearTimeout(copiedStatTimer);
    copiedStatTimer = setTimeout(() => { copiedStatKey.value = ""; }, 1200);
  } catch {
    // Ignore clipboard rejection in restricted contexts.
  }
}

function statButtonTitle(item) {
  const label = t(`selectionStats.${item.key}`);
  const value = item.fullText || item.text;
  return copiedStatKey.value === item.key
    ? `${label} ${value} · ${t("cellDetail.copied")}`
    : t("selectionStats.copyHint", { label, value });
}

watch(
  () => [selectedCellKey.value, props.textDraft, props.identityRemap?.id],
  () => {
    const inputFocused = globalThis.document?.activeElement === detailInputRef.value;
    const cellChanged = selectedCellKey.value !== loadedCellKey.value;
    const identityRemap = props.identityRemap;
    const freshIdentityRemap = identityRemap?.id != null
      && identityRemap.id !== lastIdentityRemapId.value;
    if (freshIdentityRemap) lastIdentityRemapId.value = identityRemap.id;
    const migratesLoadedCell = cellChanged
      && freshIdentityRemap
      && loadedCell.value?.tabId === identityRemap.tabId
      && loadedCell.value?.rowKey === identityRemap.previousRowKey
      && loadedCell.value?.column === identityRemap.column
      && (loadedCell.value?.kind || "data") === (identityRemap.kind || "data")
      && props.selectedCell?.rowKey === identityRemap.nextRowKey;
    if (migratesLoadedCell) {
      loadedCellKey.value = selectedCellKey.value;
      loadedCell.value = props.selectedCell ? { ...props.selectedCell } : null;
      if (!isDraftDirty.value) loadSource(props.textDraft);
      nextTick(syncDetailScroll);
      return;
    }
    if (cellChanged || (!inputFocused && props.textDraft !== sourceDraft.value)) {
      // 单元格即将切换：若 textarea 仍持有焦点，说明用户刚才在编辑原单元格，
      // 必须先用当前 sourceDraft + 原 loadedCell 身份触发 commit-detail-draft 提交，
      // 再覆盖 loadedCell/sourceDraft。否则 watch 会先用新单元格的值覆盖本地草稿，
      // 等 blur 触发时已读不到用户的输入，表现为"失焦后还原成修改前的样子"。
      // 值未改时 commitCellValue 会自行早退，不会产生多余写入。
      if (cellChanged && inputFocused && loadedCell.value && isDraftDirty.value) {
        emit("commit-detail-draft", {
          tabId: loadedCell.value.tabId,
          rowKey: loadedCell.value.rowKey,
          column: loadedCell.value.column,
          draft: sourceDraft.value,
          dirty: true,
        });
      }
      loadedCellKey.value = selectedCellKey.value;
      loadedCell.value = props.selectedCell ? { ...props.selectedCell } : null;
      loadSource(props.textDraft);
      isDraftDirty.value = false;
      nextTick(syncDetailScroll);
    }
  },
  { immediate: true },
);

// 自动展开：选中长文本（>80 字符）或含换行符的单元格时展开面板；选中短文本
// 不触发，展开后也绝不因选回短文本自动收起（收起只由用户手动触发）。
watch(
  () => [props.selectedCell, props.textDraft],
  () => {
    if (props.selectedCell) visibility.notifySelectedText(props.textDraft);
  },
);

function loadSource(text) {
  sourceDraft.value = String(text ?? "");
  applyJsonView();
}

function applyJsonView() {
  viewDraft.value = resolveDetailEditorView(sourceDraft.value, {
    prettyJson: visibility.state.jsonPretty,
  }).viewText;
}

function setJsonPretty(next) {
  cardView.value = false;
  visibility.setJsonPretty(next);
  applyJsonView();
  nextTick(syncDetailScroll);
}

function setCardViewMode() {
  if (!structuredPreview.value.canCardView) return;
  cardView.value = true;
}

function openRelationTarget(target) {
  if (!target?.relation || !target?.value) return;
  emit("open-relation-target", target);
}

function relationChipTitle(target) {
  const tableLabel = target.targetTableComment
    ? `${target.targetTable}（${target.targetTableComment}）`
    : target.targetTable;
  if (target.state === "missing") {
    return `${tableLabel}.${target.targetColumn} = ${target.value} · ${t("relations.target.missing")}`;
  }
  const valueText = target.label ? `${target.value} · ${target.label}` : target.value;
  return t("relations.target.open", { table: tableLabel || target.targetTable, value: valueText });
}

function enumChipTitle(entry) {
  if (entry.state === "unmapped") {
    return t("cellDetail.enumUnmappedTitle", { value: entry.value });
  }
  return t("cellDetail.enumTitle", { value: entry.value, label: entry.label });
}

function slotChipTitle(slot) {
  if (slot.state === "unmapped") {
    return t("cellDetail.slotUnmappedTitle", { index: slot.index, value: slot.value });
  }
  return t("cellDetail.slotTitle", { index: slot.index, label: slot.label, value: slot.value });
}

function cardPrimitiveIndexLabel(index) {
  const slot = cellSlotItems.value[index - 1];
  return slot?.label ? `#${index} · ${slot.label}` : `#${index}`;
}

function emitEditColumnMeaning() {
  if (!canEditColumnMeaning.value) return;
  emit("edit-column-meaning");
}

function updateDetailDraft(event) {
  const nextValue = event.target.value;
  viewDraft.value = nextValue;
  sourceDraft.value = nextValue;
  isDraftDirty.value = true;
  emit("update:textDraft", nextValue);
  syncDetailScroll();
}

function syncDetailScroll() {
  if (!detailInputRef.value || !detailHighlightsRef.value) return;
  detailHighlightsRef.value.scrollTop = detailInputRef.value.scrollTop;
  detailHighlightsRef.value.scrollLeft = detailInputRef.value.scrollLeft;
}

function saveDetail() {
  if (props.readOnly) return;
  commitDetailDraft();
}

// 失焦即保存：覆盖两种场景——
// 1) 点击非网格区域（侧边栏/检查器等）selectedCell 不变，@blur 直接用当前
//    loadedCell + sourceDraft 提交。
// 2) 点击别的网格单元格：watch 已先按原单元格提交并切到新单元格，此处 loadedCell
//    已是新单元格、sourceDraft 是新值，commitCellValue 会因值未变早退，是 no-op。
function commitDetailDraft() {
  if (!loadedCell.value || props.readOnly) return;
  if (!isDraftDirty.value) return;
  emit("commit-detail-draft", {
    tabId: loadedCell.value.tabId,
    rowKey: loadedCell.value.rowKey,
    column: loadedCell.value.column,
    draft: sourceDraft.value,
    dirty: true,
  });
  isDraftDirty.value = false;
}

function onDetailBlur() {
  commitDetailDraft();
}

function onDetailKeydown(event) {
  if (matchesBinding("save", event)) {
    event.preventDefault();
    saveDetail();
    return;
  }
  // Leave the editor and hand the keyboard back to the grid, so the next
  // arrow key moves the selected cell instead of doing nothing.
  if (event.key === "Escape") {
    event.preventDefault();
    detailInputRef.value?.blur();
    emit("exit-detail");
  }
}

function selectedViewText() {
  const input = detailInputRef.value;
  if (!input) return "";
  const selectionStart = Number(input.selectionStart ?? 0);
  const selectionEnd = Number(input.selectionEnd ?? selectionStart);
  return String(input.value || "").slice(selectionStart, selectionEnd);
}

function detailCopyText({ copyAllIfEmpty = false } = {}) {
  return resolveDetailCopyText({
    sourceText: sourceDraft.value,
    viewText: viewDraft.value,
    selectedViewText: selectedViewText(),
    copyAllIfEmpty,
  });
}

function onDetailCopy(event) {
  const selected = selectedViewText();
  const copyText = detailCopyText();
  if (!copyText || copyText === selected) return;
  event.preventDefault();
  event.clipboardData?.setData("text/plain", copyText);
}

function openDetailContextMenu(event) {
  const input = detailInputRef.value;
  if (!input) return;
  const selectionStart = Number(input.selectionStart ?? 0);
  const selectionEnd = Number(input.selectionEnd ?? selectionStart);
  const copyText = detailCopyText({ copyAllIfEmpty: true });
  const clipboard = globalThis.navigator?.clipboard;

  emit("detail-contextmenu", event, {
    canCopy: copyText.length > 0 && typeof clipboard?.writeText === "function",
    canPaste: Boolean(props.selectedCell && !props.readOnly && typeof clipboard?.readText === "function"),
    copy: async () => {
      if (!copyText || typeof clipboard?.writeText !== "function") return;
      await clipboard.writeText(copyText);
    },
    paste: async () => {
      if (props.readOnly || typeof clipboard?.readText !== "function") return;
      const text = String(await clipboard.readText());
      const currentValue = String(input.value || "");
      const nextValue = `${currentValue.slice(0, selectionStart)}${text}${currentValue.slice(selectionEnd)}`;
      const nextCursor = selectionStart + text.length;
      viewDraft.value = nextValue;
      sourceDraft.value = nextValue;
      isDraftDirty.value = true;
      emit("update:textDraft", nextValue);
      await nextTick();
      input.focus();
      input.setSelectionRange(nextCursor, nextCursor);
      syncDetailScroll();
    },
  });
}

// ── Collapse / expand (title bar + chevron toggle) ────────────────────
function expandPanel() {
  visibility.setCollapsed(false);
}

function collapsePanel() {
  visibility.setCollapsed(true);
}

function togglePanel() {
  if (!hasSelectedCell.value) return;
  visibility.toggleCollapsed();
}

// 收起态整条标题栏可点击展开；展开态点击标签栏不动作，只有 chevron 触发折叠，
// 避免在编辑器上方误触收起。
function onHeaderClick() {
  if (!hasSelectedCell.value) return;
  if (isPanelCollapsed.value) expandPanel();
}

async function copyDetailValue() {
  const copyText = detailCopyText({ copyAllIfEmpty: true });
  const clipboard = globalThis.navigator?.clipboard;
  if (!copyText || typeof clipboard?.writeText !== "function") return;
  try {
    await clipboard.writeText(copyText);
    copyFeedback.value = true;
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = setTimeout(() => {
      copyFeedback.value = false;
      copyFeedbackTimer = 0;
    }, 1400);
  } catch {
    /* ignore clipboard permission errors */
  }
}

// ── Resizable height (no drag icon, just a slim divider bar) ──────────
function maxDetailHeight() {
  const height = rootRef.value?.parentElement?.getBoundingClientRect?.().height;
  if (!Number.isFinite(height) || height <= 0) return DETAIL_DEFAULT_HEIGHT;
  // Leave at least ~180px for the table above.
  return Math.max(DETAIL_MIN_HEIGHT, Math.floor(height - 180));
}

// During the drag the height is clamped to the snap zone at the bottom;
// releasing there collapses the panel instead of keeping a sliver open.
function clampDetailHeight(height) {
  return Math.max(COLLAPSE_SNAP_THRESHOLD, Math.min(maxDetailHeight(), Math.round(height)));
}

function finishResize() {
  removeDragListeners?.();
  removeDragListeners = null;
  isResizing.value = false;
  if (globalThis.document?.body?.style) {
    globalThis.document.body.style.cursor = "";
    globalThis.document.body.style.userSelect = "";
  }
  // Release in the snap zone = collapse to the title bar; expanding later
  // restores the default height rather than the dragged sliver.
  if (detailHeight.value <= COLLAPSE_SNAP_THRESHOLD) {
    detailHeight.value = DETAIL_DEFAULT_HEIGHT;
    collapsePanel();
  }
}

function onDividerMouseDown(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  finishResize();

  const startY = event.clientY;
  const startHeight = clampDetailHeight(detailHeight.value);
  detailHeight.value = startHeight;
  isResizing.value = true;

  if (globalThis.document?.body?.style) {
    globalThis.document.body.style.cursor = "row-resize";
    globalThis.document.body.style.userSelect = "none";
  }

  const onMove = (moveEvent) => {
    detailHeight.value = clampDetailHeight(startHeight + startY - moveEvent.clientY);
  };
  const onUp = () => finishResize();

  globalThis.window?.addEventListener("mousemove", onMove);
  globalThis.window?.addEventListener("mouseup", onUp);
  removeDragListeners = () => {
    globalThis.window?.removeEventListener("mousemove", onMove);
    globalThis.window?.removeEventListener("mouseup", onUp);
  };
}

function onDividerKeydown(event) {
  if (event.key === "Home") {
    event.preventDefault();
    detailHeight.value = clampDetailHeight(DETAIL_DEFAULT_HEIGHT);
    return;
  }
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  const direction = event.key === "ArrowUp" ? 1 : -1;
  const step = event.shiftKey ? KEYBOARD_STEP * 3 : KEYBOARD_STEP;
  const next = clampDetailHeight(detailHeight.value + direction * step);
  detailHeight.value = next;
  if (next <= COLLAPSE_SNAP_THRESHOLD) {
    detailHeight.value = DETAIL_DEFAULT_HEIGHT;
    collapsePanel();
  }
}

onBeforeUnmount(() => {
  finishResize();
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = 0;
  if (copiedStatTimer) clearTimeout(copiedStatTimer);
  copiedStatTimer = 0;
});
</script>

<template>
  <section
    ref="rootRef"
    class="wb-cell-detail"
    :class="{ 'is-resizing': isResizing, 'is-collapsed': isPanelCollapsed, 'is-compact': isCompact, 'is-read-only-context': readOnly, 'is-field-comment': isFieldComment, 'has-selection': hasSelectedCell }"
    :style="ambientStyle"
    :aria-label="t('m_946f88c2a713')"
  >
    <div
      class="wb-cell-detail-header"
      :class="{ 'is-collapsed': isPanelCollapsed, 'has-selection': hasSelectedCell }"
      @click="onHeaderClick"
    >
      <div class="wb-cell-detail-leading">
        <span class="wb-cell-detail-title">{{ t('m_891aaf102229') }}</span>
        <span
          v-if="cellTargetLabel"
          class="wb-cell-detail-target"
          :title="cellTargetComment ? `${cellTargetLabel} · ${cellTargetComment}` : cellTargetLabel"
        >
          <span class="wb-cell-detail-target-key">{{ cellTargetLabel }}</span>
        </span>
        <span v-else class="wb-cell-detail-idle-hint">{{ t('cellDetail.idleHint') }}</span>
        <span v-if="isNull && !isFieldComment" class="wb-cell-detail-null-state">{{ t('m_05dac0ecc1ae') }}</span>
        <div
          v-if="isPanelCollapsed && (collapsedEnumItems.length || collapsedSlotItems.length || collapsedInlineTargets.length)"
          class="wb-cell-detail-header-refs"
          @click.stop
        >
          <span
            v-for="(entry, index) in collapsedEnumItems"
            :key="`enum:${entry.value}:${index}`"
            class="wb-cell-detail-enum-chip"
            :class="`is-${entry.state}`"
            :title="enumChipTitle(entry)"
          >
            <Tag :size="10" aria-hidden="true" />
            <span class="wb-cell-detail-ref-id">{{ entry.value }}</span>
            <span v-if="entry.label" class="wb-cell-detail-ref-name">{{ entry.label }}</span>
            <span v-else class="wb-cell-detail-ref-missing">{{ t('cellDetail.enumUnmapped') }}</span>
          </span>
          <span
            v-for="slot in collapsedSlotItems"
            :key="`slot:${slot.index}`"
            class="wb-cell-detail-enum-chip"
            :class="`is-${slot.state}`"
            :title="slotChipTitle(slot)"
          >
            <ListOrdered :size="10" aria-hidden="true" />
            <span class="wb-cell-detail-ref-name">{{ slot.label || `#${slot.index}` }}</span>
            <span class="wb-cell-detail-ref-id">{{ slot.value }}</span>
          </span>
          <button
            v-for="(target, index) in collapsedInlineTargets"
            :key="`${target.targetTable}:${target.value}:${index}`"
            type="button"
            class="wb-cell-detail-ref-chip"
            :class="`is-${target.state}`"
            :title="relationChipTitle(target)"
            :disabled="target.state === 'missing'"
            @click.stop="openRelationTarget(target)"
          >
            <Link2 :size="10" aria-hidden="true" />
            <span class="wb-cell-detail-ref-id">{{ target.value }}</span>
            <span v-if="target.label" class="wb-cell-detail-ref-name">{{ target.label }}</span>
            <span v-else-if="target.state === 'missing'" class="wb-cell-detail-ref-missing">{{ t('relations.target.missing') }}</span>
          </button>
          <span v-if="collapsedInlineExtraCount > 0" class="wb-cell-detail-ref-more">+{{ collapsedInlineExtraCount }}</span>
        </div>
        <div
          v-if="showJsonFormatToggle"
          class="wb-cell-detail-format"
          role="group"
          :aria-label="t('m_d74ba3d54a21')"
        >
          <button
            type="button"
            :class="{ 'is-active': jsonRaw }"
            :aria-pressed="String(jsonRaw)"
            :title="t('m_4126e3b37b7a')"
            @click.stop="setJsonPretty(false)"
          >{{ t('m_8cb7c0a54b21') }}</button>
          <button
            type="button"
            :class="{ 'is-active': jsonPretty }"
            :aria-pressed="String(jsonPretty)"
            :title="t('m_9d1a0cae95c8')"
            @click.stop="setJsonPretty(true)"
          >{{ t('m_f69273dbbebf') }}</button>
          <button
            v-if="structuredPreview.canCardView"
            type="button"
            :class="{ 'is-active': cardView }"
            :aria-pressed="String(cardView)"
            :title="t('cellDetail.cardViewHint')"
            @click.stop="setCardViewMode"
          >{{ t('cellDetail.cardView') }}</button>
        </div>
        <button
          v-if="canCopyDetail"
          type="button"
          class="wb-cell-detail-copy-btn"
          :class="{ 'is-copied': copyFeedback }"
          :title="copyFeedback ? t('cellDetail.copied') : t('cellDetail.copy')"
          :aria-label="copyFeedback ? t('cellDetail.copied') : t('cellDetail.copy')"
          @click.stop="copyDetailValue"
        >
          <Check v-if="copyFeedback" :size="12" :stroke-width="2.2" aria-hidden="true" />
          <Copy v-else :size="12" :stroke-width="1.8" aria-hidden="true" />
          <span>{{ copyFeedback ? t('cellDetail.copied') : t('cellDetail.copy') }}</span>
        </button>
        <button
          v-if="canEditColumnMeaning"
          type="button"
          class="wb-cell-detail-copy-btn wb-cell-detail-meaning-btn"
          :title="t('cellDetail.editMeaningHint')"
          :aria-label="t('cellDetail.editMeaning')"
          @click.stop="emitEditColumnMeaning"
        >
          <SlidersHorizontal :size="12" :stroke-width="1.8" aria-hidden="true" />
          <span>{{ t('cellDetail.editMeaning') }}</span>
        </button>
      </div>
      <div class="wb-cell-detail-header-actions">
        <div
          v-if="selectionStatItems.length"
          class="wb-cell-detail-stats"
          :aria-label="t('m_63aec19ea490')"
        >
          <button
            v-for="item in selectionStats.items"
            :key="item.key"
            type="button"
            class="wb-cell-detail-stat"
            :class="{ 'is-copied': copiedStatKey === item.key }"
            :title="statButtonTitle(item)"
            @click.stop="copyStatValue(item)"
          >
            <span class="wb-cell-detail-stat-label">{{ copiedStatKey === item.key ? t('cellDetail.copied') : t(`selectionStats.${item.key}`) }}</span>
            <strong class="wb-cell-detail-stat-value">{{ item.text }}</strong>
          </button>
          <button
            v-for="item in selectionRangeItems"
            :key="item.key"
            type="button"
            class="wb-cell-detail-stat"
            :class="{ 'is-copied': copiedStatKey === item.key }"
            :title="statButtonTitle(item)"
            @click.stop="copyStatValue(item)"
          >
            <span class="wb-cell-detail-stat-label">{{ copiedStatKey === item.key ? t('cellDetail.copied') : t(`selectionStats.${item.key}`) }}</span>
            <strong class="wb-cell-detail-stat-value">{{ item.text }}</strong>
          </button>
        </div>
        <span
          v-if="rowSummary"
          class="wb-cell-detail-row-summary"
          :class="{ 'has-divider': selectionStatItems.length > 0 }"
          :title="rowSummary"
        >{{ rowSummary }}</span>
        <button
          type="button"
          class="wb-cell-detail-toggle"
          :disabled="!hasSelectedCell"
          :aria-expanded="String(!isPanelCollapsed)"
          :aria-label="toggleLabel"
          :title="toggleLabel"
          @click.stop="togglePanel"
        >
          <ChevronUp v-if="isPanelCollapsed" class="wb-cell-detail-chevron" :size="18" :stroke-width="2" aria-hidden="true" />
          <ChevronDown v-else class="wb-cell-detail-chevron" :size="18" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>
    </div>
    <div
      class="wb-cell-detail-content"
      :style="contentStyle"
      :aria-hidden="isPanelCollapsed"
    >
      <div
        class="wb-cell-detail-handle"
        role="separator"
        :aria-label="t('m_42f1b42584a7')"
        aria-orientation="horizontal"
        :tabindex="isPanelCollapsed ? -1 : 0"
        @mousedown="onDividerMouseDown"
        @dblclick="detailHeight = clampDetailHeight(DETAIL_DEFAULT_HEIGHT)"
        @keydown="onDividerKeydown"
      >
        <span class="wb-cell-detail-handle-grip" aria-hidden="true"></span>
      </div>
      <div class="wb-cell-detail-body" :style="detailPanelStyle">
        <div
          v-if="!showCardView && hasInlineMeaningChips"
          class="wb-cell-detail-refs"
        >
          <span
            v-for="(entry, index) in cellEnumItems"
            :key="`enum:${entry.value}:${index}`"
            class="wb-cell-detail-enum-chip"
            :class="`is-${entry.state}`"
            :title="enumChipTitle(entry)"
          >
            <Tag :size="10" aria-hidden="true" />
            <span class="wb-cell-detail-ref-id">{{ entry.value }}</span>
            <span v-if="entry.label" class="wb-cell-detail-ref-name">{{ entry.label }}</span>
            <span v-else class="wb-cell-detail-ref-missing">{{ t('cellDetail.enumUnmapped') }}</span>
          </span>
          <span
            v-for="slot in cellSlotItems"
            :key="`slot:${slot.index}`"
            class="wb-cell-detail-enum-chip"
            :class="`is-${slot.state}`"
            :title="slotChipTitle(slot)"
          >
            <ListOrdered :size="10" aria-hidden="true" />
            <span class="wb-cell-detail-ref-name">{{ slot.label || `#${slot.index}` }}</span>
            <span class="wb-cell-detail-ref-id">{{ slot.value }}</span>
          </span>
          <button
            v-for="(target, index) in structuredPreview.inlineTargets"
            :key="`${target.targetTable}:${target.value}:${index}`"
            type="button"
            class="wb-cell-detail-ref-chip"
            :class="`is-${target.state}`"
            :title="relationChipTitle(target)"
            :disabled="target.state === 'missing'"
            @click.stop="openRelationTarget(target)"
          >
            <Link2 :size="10" aria-hidden="true" />
            <span class="wb-cell-detail-ref-id">{{ target.value }}</span>
            <span v-if="target.label" class="wb-cell-detail-ref-name">{{ target.label }}</span>
            <span v-else-if="target.state === 'missing'" class="wb-cell-detail-ref-missing">{{ t('relations.target.missing') }}</span>
          </button>
        </div>
        <div v-if="showCardView" class="wb-detail-cards">
          <template v-if="structuredPreview.kind === 'json-array-primitives'">
            <div class="wb-detail-card-primitives">
              <div
                v-for="item in structuredPreview.items"
                :key="item.index"
                class="wb-detail-primitive-pill"
              >
                <span class="wb-detail-card-index">{{ cardPrimitiveIndexLabel(item.index) }}</span>
                <span class="wb-detail-card-val">{{ item.value }}</span>
                <button
                  v-if="item.target"
                  type="button"
                  class="wb-cell-detail-ref-chip"
                  :class="`is-${item.target.state}`"
                  :title="relationChipTitle(item.target)"
                  :disabled="item.target.state === 'missing'"
                  @click.stop="openRelationTarget(item.target)"
                >
                  <span v-if="item.target.label" class="wb-cell-detail-ref-name">{{ item.target.label }}</span>
                  <span v-else-if="item.target.state === 'missing'" class="wb-cell-detail-ref-missing">{{ t('relations.target.missing') }}</span>
                  <span v-else class="wb-cell-detail-ref-id">{{ item.target.targetTable }}</span>
                </button>
              </div>
            </div>
          </template>
          <template v-else>
            <article
              v-for="card in structuredPreview.cards"
              :key="card.index"
              class="wb-detail-card"
            >
              <span v-if="structuredPreview.cards.length > 1" class="wb-detail-card-index">#{{ card.index }}</span>
              <div class="wb-detail-card-fields">
                <div
                  v-for="field in card.entries"
                  :key="field.key"
                  class="wb-detail-card-field"
                >
                  <span class="wb-detail-card-key">{{ field.key }}</span>
                  <span class="wb-detail-card-val">{{ field.value }}</span>
                  <button
                    v-if="field.target"
                    type="button"
                    class="wb-cell-detail-ref-chip"
                    :class="`is-${field.target.state}`"
                    :title="relationChipTitle(field.target)"
                    :disabled="field.target.state === 'missing'"
                    @click.stop="openRelationTarget(field.target)"
                  >
                    <Link2 :size="10" aria-hidden="true" />
                    <span v-if="field.target.label" class="wb-cell-detail-ref-name">{{ field.target.label }}</span>
                    <span v-else-if="field.target.state === 'missing'" class="wb-cell-detail-ref-missing">{{ t('relations.target.missing') }}</span>
                    <span v-else class="wb-cell-detail-ref-id">{{ field.target.targetTable }}</span>
                  </button>
                </div>
              </div>
            </article>
          </template>
        </div>
        <div v-else class="wb-detail-editor" :class="[`is-${detailFormatting.kind}`, { 'has-highlight': hasInlineFormatting }]">
          <pre
            v-if="hasInlineFormatting"
            ref="detailHighlightsRef"
            class="wb-detail-highlights"
            aria-hidden="true"
            v-html="detailFormatting.html"
          ></pre>
          <textarea
            ref="detailInputRef"
            class="wb-detail-input"
            :value="viewDraft"
            :disabled="!selectedCell"
            :readonly="readOnly"
            :placeholder="detailPlaceholder"
            :tabindex="isPanelCollapsed ? -1 : 0"
            :aria-label="isFieldComment ? t('cellDetail.fieldCommentReadonly', { column: selectedCell?.column || '' }) : t('m_946f88c2a713')"
            @input="updateDetailDraft"
            @scroll="syncDetailScroll"
            @blur="onDetailBlur"
            @keydown="onDetailKeydown"
            @copy="onDetailCopy"
            @contextmenu.prevent.stop="openDetailContextMenu"
          ></textarea>
        </div>
      </div>
    </div>
  </section>
</template>
