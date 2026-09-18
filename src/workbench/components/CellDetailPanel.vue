<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ChevronDown, ChevronUp } from "lucide-vue-next";
import { highlightDetailValue, isDetailJson, resolveDetailCopyText, resolveDetailEditorView } from "../utils/cellDisplay.js";
import { createCellDetailVisibility } from "../cellDetailVisibility.js";

const props = defineProps({
  selectedCell: { type: Object, default: null },
  textDraft: { type: String, default: "" },
  identityRemap: { type: Object, default: null },
  readOnly: { type: Boolean, default: false },
  isNull: { type: Boolean, default: false },
  selectionStats: { type: Object, default: null },
});

const emit = defineEmits(["update:textDraft", "save-text-panel", "commit-detail-draft", "detail-contextmenu"]);

const DETAIL_DEFAULT_HEIGHT = 200;
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
let removeDragListeners = null;

const selectedCellKey = computed(() =>
  props.selectedCell ? [props.selectedCell.tabId, props.selectedCell.rowKey, props.selectedCell.column, props.selectedCell.kind || "data"].join("") : "",
);
const isFieldComment = computed(() => props.selectedCell?.kind === "fieldComment");
const detailPlaceholder = computed(() => (
  isFieldComment.value
    ? "字段备注（只读）"
    : "选中单元格后在这里查看或编辑长文本（失焦或 Ctrl+S 保存）"
));
const isJsonDetail = computed(() => isDetailJson(sourceDraft.value));
const jsonPretty = computed(() => visibility.state.jsonPretty);
const detailFormatting = computed(() => highlightDetailValue(viewDraft.value));
const hasInlineFormatting = computed(() => props.selectedCell && detailFormatting.value.kind !== "text");
const detailPanelStyle = computed(() => ({ height: `${detailHeight.value}px` }));
const isPanelCollapsed = computed(() => visibility.state.collapsed);
const showJsonFormatToggle = computed(() => Boolean(props.selectedCell && isJsonDetail.value && !isPanelCollapsed.value));
const isCompact = computed(() => detailHeight.value <= COMPACT_HEIGHT);
// 收起时内容区高度动画到 0，把垂直空间平滑还给数据网格；展开恢复为
// 拖柄 + 编辑器高度。动画时长/缓动见 CSS 里的 pane-collapse token。
const contentStyle = computed(() => (
  isPanelCollapsed.value
    ? { height: "0px", opacity: "0" }
    : { height: `${HANDLE_HEIGHT + detailHeight.value}px`, opacity: "1" }
));
const toggleLabel = computed(() => (isPanelCollapsed.value ? "展开单元格内容" : "收起单元格内容"));
const selectionStatItems = computed(() => (
  Array.isArray(props.selectionStats?.items) ? props.selectionStats.items : []
));

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
  visibility.setJsonPretty(next);
  applyJsonView();
  nextTick(syncDetailScroll);
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
  // Ctrl/Cmd+S saves the detail panel even while the textarea is focused (#3).
  const key = String(event.key || "").toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "s") {
    event.preventDefault();
    saveDetail();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    detailInputRef.value?.blur();
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
  visibility.toggleCollapsed();
}

// 收起态整条标题栏可点击展开；展开态点击标签栏不动作，只有 chevron 触发折叠，
// 避免在编辑器上方误触收起。
function onHeaderClick() {
  if (isPanelCollapsed.value) expandPanel();
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

onBeforeUnmount(finishResize);
</script>

<template>
  <section
    ref="rootRef"
    class="wb-cell-detail"
    :class="{ 'is-resizing': isResizing, 'is-collapsed': isPanelCollapsed, 'is-compact': isCompact, 'is-read-only-context': readOnly, 'is-field-comment': isFieldComment }"
    aria-label="单元格详情"
  >
    <div
      class="wb-cell-detail-header"
      :class="{ 'is-collapsed': isPanelCollapsed }"
      @click="onHeaderClick"
    >
      <span v-if="!selectionStatItems.length" class="wb-cell-detail-title">单元格内容</span>
      <div
        v-else
        class="wb-cell-detail-stats"
        aria-label="选区统计"
      >
        <span
          v-for="item in selectionStats.items"
          :key="item.key"
          class="wb-cell-detail-stat"
        >
          <span class="wb-cell-detail-stat-label">{{ item.label }}</span>
          <strong class="wb-cell-detail-stat-value">{{ item.text }}</strong>
        </span>
      </div>
      <span v-if="isNull && !isFieldComment" class="wb-cell-detail-null-state">SQL NULL · 编辑后保存为空字符串</span>
      <div class="wb-cell-detail-header-actions">
        <div
          v-if="showJsonFormatToggle"
          class="wb-cell-detail-format"
          role="group"
          aria-label="JSON 显示"
        >
          <button
            type="button"
            :class="{ 'is-active': !jsonPretty }"
            :aria-pressed="String(!jsonPretty)"
            title="显示原始 JSON"
            @click.stop="setJsonPretty(false)"
          >原始</button>
          <button
            type="button"
            :class="{ 'is-active': jsonPretty }"
            :aria-pressed="String(jsonPretty)"
            title="格式化 JSON"
            @click.stop="setJsonPretty(true)"
          >格式化</button>
        </div>
        <button
          type="button"
          class="wb-cell-detail-toggle"
          :aria-expanded="String(!isPanelCollapsed)"
          :aria-label="toggleLabel"
          :title="toggleLabel"
          @click.stop="togglePanel"
        >
          <ChevronUp v-if="isPanelCollapsed" class="wb-cell-detail-chevron" :size="13" aria-hidden="true" />
          <ChevronDown v-else class="wb-cell-detail-chevron" :size="13" aria-hidden="true" />
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
        aria-label="拖动调整详情区域高度（拖到底部附近可收起）"
        aria-orientation="horizontal"
        :tabindex="isPanelCollapsed ? -1 : 0"
        @mousedown="onDividerMouseDown"
        @dblclick="detailHeight = clampDetailHeight(DETAIL_DEFAULT_HEIGHT)"
        @keydown="onDividerKeydown"
      >
        <span class="wb-cell-detail-handle-grip" aria-hidden="true"></span>
      </div>
      <div class="wb-cell-detail-body" :style="detailPanelStyle">
        <div class="wb-detail-editor" :class="[`is-${detailFormatting.kind}`, { 'has-highlight': hasInlineFormatting }]">
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
            :aria-label="isFieldComment ? `字段 ${selectedCell?.column || ''} 的备注（只读）` : '单元格详情'"
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
