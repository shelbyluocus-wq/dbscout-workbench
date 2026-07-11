<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { formatDetailValue, highlightDetailValue } from "../utils/cellDisplay.js";

const props = defineProps({
  selectedCell: { type: Object, default: null },
  textDraft: { type: String, default: "" },
  readOnly: { type: Boolean, default: false },
});

const emit = defineEmits(["update:textDraft", "save-text-panel", "commit-detail-draft", "detail-contextmenu"]);

const DETAIL_DEFAULT_HEIGHT = 200;
const DETAIL_MIN_HEIGHT = 96;
// Height at/under which the panel is considered "collapsed": only the grab
// handle is shown so the user can pull it back up (#4).
const COLLAPSED_HEIGHT = 6;
const COLLAPSE_SNAP_THRESHOLD = 24;
const COMPACT_HEIGHT = 72;
const HANDLE_HEIGHT = 7;
const KEYBOARD_STEP = 12;

const rootRef = ref(null);
const detailInputRef = ref(null);
const detailHighlightsRef = ref(null);
const editorDraft = ref("");
const loadedCellKey = ref("");
// 结构化记录当前 textarea 草稿所属的单元格。失焦时如果 selectedCell 已被
// 切换到别的单元格（点击网格换行），仍能按原单元格提交，避免草稿丢失或写错行。
const loadedCell = ref(null);
const detailHeight = ref(DETAIL_DEFAULT_HEIGHT);
const isResizing = ref(false);
let removeDragListeners = null;

const selectedCellKey = computed(() =>
  props.selectedCell ? [props.selectedCell.tabId, props.selectedCell.rowKey, props.selectedCell.column].join("\u0000") : "",
);
const detailFormatting = computed(() => highlightDetailValue(editorDraft.value));
const hasInlineFormatting = computed(() => props.selectedCell && detailFormatting.value.kind !== "text");
const detailPanelStyle = computed(() => ({ height: `${detailHeight.value}px` }));
const isCollapsed = computed(() => detailHeight.value <= COLLAPSED_HEIGHT);
const isCompact = computed(() => detailHeight.value <= COMPACT_HEIGHT);

watch(
  () => [selectedCellKey.value, props.textDraft],
  () => {
    const inputFocused = globalThis.document?.activeElement === detailInputRef.value;
    const cellChanged = selectedCellKey.value !== loadedCellKey.value;
    if (cellChanged || (!inputFocused && props.textDraft !== editorDraft.value)) {
      // 单元格即将切换：若 textarea 仍持有焦点，说明用户刚才在编辑原单元格，
      // 必须先用当前 editorDraft + 原 loadedCell 身份触发 commit-detail-draft 提交，
      // 再覆盖 loadedCell/editorDraft。否则 watch 会先用新单元格的值覆盖本地草稿，
      // 等 blur 触发时已读不到用户的输入，表现为"失焦后还原成修改前的样子"。
      // 值未改时 commitCellValue 会自行早退，不会产生多余写入。
      if (cellChanged && inputFocused && loadedCell.value) {
        emit("commit-detail-draft", {
          tabId: loadedCell.value.tabId,
          rowKey: loadedCell.value.rowKey,
          column: loadedCell.value.column,
          draft: editorDraft.value,
        });
      }
      loadedCellKey.value = selectedCellKey.value;
      loadedCell.value = props.selectedCell ? { ...props.selectedCell } : null;
      editorDraft.value = formatDetailValue(props.textDraft).text;
      nextTick(syncDetailScroll);
    }
  },
  { immediate: true },
);

function updateDetailDraft(event) {
  editorDraft.value = event.target.value;
  emit("update:textDraft", event.target.value);
  syncDetailScroll();
}

function syncDetailScroll() {
  if (!detailInputRef.value || !detailHighlightsRef.value) return;
  detailHighlightsRef.value.scrollTop = detailInputRef.value.scrollTop;
  detailHighlightsRef.value.scrollLeft = detailInputRef.value.scrollLeft;
}

function saveDetail() {
  emit("save-text-panel");
}

// 失焦即保存：覆盖两种场景——
// 1) 点击非网格区域（侧边栏/检查器等）selectedCell 不变，@blur 直接用当前
//    loadedCell + editorDraft 提交。
// 2) 点击别的网格单元格：watch 已先按原单元格提交并切到新单元格，此处 loadedCell
//    已是新单元格、editorDraft 是新值，commitCellValue 会因值未变早退，是 no-op。
function commitDetailDraft() {
  if (!loadedCell.value) return;
  emit("commit-detail-draft", {
    tabId: loadedCell.value.tabId,
    rowKey: loadedCell.value.rowKey,
    column: loadedCell.value.column,
    draft: editorDraft.value,
  });
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

function openDetailContextMenu(event) {
  const input = detailInputRef.value;
  if (!input) return;
  const selectionStart = Number(input.selectionStart ?? 0);
  const selectionEnd = Number(input.selectionEnd ?? selectionStart);
  const selectedText = String(input.value || "").slice(selectionStart, selectionEnd);
  const copyText = selectedText || String(input.value || "");
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
      editorDraft.value = nextValue;
      emit("update:textDraft", nextValue);
      await nextTick();
      input.focus();
      input.setSelectionRange(nextCursor, nextCursor);
      syncDetailScroll();
    },
  });
}

// ── Resizable height (no drag icon, just a slim divider bar) ──────────
function maxDetailHeight() {
  const height = rootRef.value?.parentElement?.getBoundingClientRect?.().height;
  if (!Number.isFinite(height) || height <= 0) return DETAIL_DEFAULT_HEIGHT;
  // Leave at least ~180px for the table above.
  return Math.max(DETAIL_MIN_HEIGHT, Math.floor(height - 180));
}

// Allow collapsing all the way down to COLLAPSED_HEIGHT so the panel can be
// dragged out of the way, leaving only the grab handle (#4).
function clampDetailHeight(height) {
  return Math.max(COLLAPSED_HEIGHT, Math.min(maxDetailHeight(), Math.round(height)));
}

function finishResize() {
  removeDragListeners?.();
  removeDragListeners = null;
  isResizing.value = false;
  if (globalThis.document?.body?.style) {
    globalThis.document.body.style.cursor = "";
    globalThis.document.body.style.userSelect = "";
  }
  // Keep the user's release height. Only snap when they clearly drag the
  // panel down to the floor, avoiding the old jump back to DETAIL_MIN_HEIGHT.
  if (detailHeight.value <= COLLAPSE_SNAP_THRESHOLD) detailHeight.value = COLLAPSED_HEIGHT;
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

// Click the collapsed handle to expand back to the default height.
function expandFromCollapsed() {
  if (isCollapsed.value) detailHeight.value = clampDetailHeight(DETAIL_DEFAULT_HEIGHT);
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
  detailHeight.value = clampDetailHeight(detailHeight.value + direction * step);
}

onBeforeUnmount(finishResize);
</script>

<template>
  <section
    ref="rootRef"
    class="wb-cell-detail"
    :class="{ 'is-resizing': isResizing, 'is-collapsed': isCollapsed, 'is-compact': isCompact }"
    :style="isCollapsed ? { height: HANDLE_HEIGHT + 'px' } : null"
    aria-label="单元格详情"
  >
    <div
      class="wb-cell-detail-handle"
      :class="{ 'is-collapsed': isCollapsed }"
      role="separator"
      :aria-label="isCollapsed ? '展开单元格详情' : '拖动调整详情区域高度（拖到底部附近可收起）'"
      aria-orientation="horizontal"
      tabindex="0"
      @mousedown="onDividerMouseDown"
      @click="expandFromCollapsed"
      @dblclick="isCollapsed ? expandFromCollapsed() : (detailHeight = clampDetailHeight(DETAIL_DEFAULT_HEIGHT))"
      @keydown="onDividerKeydown"
    >
      <span class="wb-cell-detail-handle-grip" aria-hidden="true"></span>
    </div>
    <div v-if="!isCollapsed" class="wb-cell-detail-body" :style="detailPanelStyle">
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
          :value="editorDraft"
          :disabled="!selectedCell"
          :readonly="readOnly"
          placeholder="选中单元格后在这里查看或编辑长文本（失焦或 Ctrl+S 保存）"
          @input="updateDetailDraft"
          @scroll="syncDetailScroll"
          @blur="onDetailBlur"
          @keydown="onDetailKeydown"
          @contextmenu.prevent.stop="openDetailContextMenu"
        ></textarea>
      </div>
    </div>
  </section>
</template>
