<script setup>
import { t } from "../i18n/index.js";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { FileSpreadsheet, FileUp, GitCompareArrows, X } from "lucide-vue-next";
import { useEscClose } from "../composables/useEscClose.js";
import {
  dataTransferHasFiles,
  extractDroppedBatchImportFiles,
  planBatchImportDrop,
} from "../utils/batchImportDrop.js";
import {
  centerDialogFrame,
  clampDialogFrame,
  dialogViewportMatches,
  moveDialogFrame,
  readBatchImportDialogPlacement,
  resizeDialogFrame,
  saveBatchImportDialogFrame,
} from "../utils/batchImportDialogFrame.js";
import BatchImportComparison from "./BatchImportComparison.vue";

const props = defineProps({
  transfer: { type: Object, required: true },
});

const emit = defineEmits(["close", "file-selected", "files-dropped", "execute"]);

const fileInput = ref(null);
const query = ref("");
const viewMode = ref("scope");
const comparisonFullscreen = ref(false);
const dialogRef = ref(null);
const frame = ref(null);
let userPositioned = false;
let placedViewport = null;
const resizing = ref(false);
const moving = ref(false);
const draggingFile = ref(false);
const dropError = ref("");
const dropNotice = ref("");
let dragDepth = 0;
const resizeHandles = [
  { edge: "n", label: "调整窗口上边缘", orientation: "horizontal", edges: { top: true } },
  { edge: "s", label: "调整窗口下边缘", orientation: "horizontal", edges: { bottom: true } },
  { edge: "e", label: "调整窗口右边缘", orientation: "vertical", edges: { right: true } },
  { edge: "w", label: "调整窗口左边缘", orientation: "vertical", edges: { left: true } },
  { edge: "nw", label: "调整窗口左上角", edges: { top: true, left: true } },
  { edge: "ne", label: "调整窗口右上角", edges: { top: true, right: true } },
  { edge: "sw", label: "调整窗口左下角", edges: { bottom: true, left: true } },
  { edge: "se", label: "调整窗口右下角", edges: { bottom: true, right: true } },
];
const batch = computed(() => props.transfer.batchImport);
const isBusy = computed(() =>
  batch.value.importing || batch.value.comparison.running || batch.value.status === "reading"
);
const selectedCount = computed(() => props.transfer.selectedImportCount.value);
const matchedSheets = computed(() => batch.value.sheets.filter((sheet) => sheet.targetTableName).length);
const targetTables = computed(() => batch.value.tables.map((table) => table.table_name));
const comparisonAvailable = computed(() =>
  ["succeeded", "partial", "cancelled"].includes(batch.value.comparison.status)
);
const comparisonComplete = computed(() =>
  ["succeeded", "partial"].includes(batch.value.comparison.status)
);
const comparisonChangeCount = computed(() =>
  Number(batch.value.comparison.summary.inserted || 0) +
  Number(batch.value.comparison.summary.updated || 0) +
  Number(batch.value.comparison.summary.deleted || 0)
);
const replacementComparisonReady = computed(() =>
  batch.value.comparison.status === "succeeded" && !batch.value.comparison.stale
);
const currentProgress = computed(() =>
  batch.value.comparison.running ? batch.value.comparison.progress : batch.value.progress
);
const importButtonLabel = computed(() => {
  if (replacementComparisonReady.value && comparisonChangeCount.value === 0) return "没有需要同步的变化";
  if (batch.value.result) return "再次同步";
  if (comparisonComplete.value && !batch.value.comparison.stale && comparisonChangeCount.value > 0) {
    return `同步 ${comparisonChangeCount.value} 条变化`;
  }
  return "开始同步";
});

// 组件由父组件 v-if 渲染，挂载即打开；忙碌时 Esc 不关闭。
useEscClose(() => true, () => emit("close"), () => isBusy.value || comparisonFullscreen.value, { dialogRef });
const modeOptions = [
  { value: "workbook", label: "合并工作簿" },
  { value: "separate", label: "每表一个 Excel" },
];
const hasLoadedFile = computed(() => Boolean(batch.value.fileName));
const canAcceptDrop = computed(() => !isBusy.value && !batch.value.readOnly && !comparisonFullscreen.value);
const showDropCover = computed(() =>
  draggingFile.value && canAcceptDrop.value && (hasLoadedFile.value || viewMode.value === "comparison")
);
const filePrompt = computed(() => (
  batch.value.mode === "separate"
    ? t("batchImport.dropPromptSeparate")
    : t("batchImport.dropPromptWorkbook")
));
const fileDropHint = computed(() => (
  batch.value.mode === "separate"
    ? t("batchImport.dropHintSeparate")
    : t("batchImport.dropHintWorkbook")
));
const searchPlaceholder = computed(() => (batch.value.mode === "separate" ? "搜索文件或目标表" : "搜索工作表或目标表"));
const allSelected = computed({
  get() {
    const selectable = batch.value.sheets.filter((sheet) =>
      sheet.targetTableName && sheet.headers.some((header) => String(header || "").trim())
    );
    return selectable.length > 0 && selectable.every((sheet) => batch.value.selectedSheetNames.has(sheet.sheetName));
  },
  set(value) {
    props.transfer.setAllImportSheets(value);
  },
});

const filteredSheets = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return batch.value.sheets;
  return batch.value.sheets.filter((sheet) =>
    String(sheet.sheetName || "").toLowerCase().includes(needle) ||
    String(sheet.targetTableName || "").toLowerCase().includes(needle)
  );
});

const progressPercent = computed(() => {
  const total = currentProgress.value.total || 0;
  if (!total) return 0;
  return Math.min(100, Math.round((currentProgress.value.done / total) * 100));
});

function resetDragState() {
  dragDepth = 0;
  draggingFile.value = false;
}

function selectMode(mode) {
  dropError.value = "";
  dropNotice.value = "";
  props.transfer.setBatchImportMode(mode);
}

function onFileInputChange(event) {
  dropError.value = "";
  dropNotice.value = "";
  emit("file-selected", event);
}

function onOverlayDragEnter(event) {
  if (!dataTransferHasFiles(event.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
  dragDepth += 1;
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = canAcceptDrop.value ? "copy" : "none";
  }
  if (canAcceptDrop.value) {
    draggingFile.value = true;
    dropError.value = "";
  }
}

function onOverlayDragOver(event) {
  if (!dataTransferHasFiles(event.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = canAcceptDrop.value ? "copy" : "none";
  }
  if (canAcceptDrop.value) {
    draggingFile.value = true;
  }
}

function onOverlayDragLeave(event) {
  if (!draggingFile.value && dragDepth === 0) return;
  event.preventDefault();
  event.stopPropagation();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0 || (event.relatedTarget && !event.currentTarget?.contains(event.relatedTarget))) {
    resetDragState();
  }
}

async function onOverlayDrop(event) {
  const hasFiles = dataTransferHasFiles(event.dataTransfer);
  resetDragState();
  if (!hasFiles) return;
  event.preventDefault();
  event.stopPropagation();
  if (!canAcceptDrop.value) return;
  dropError.value = "";
  dropNotice.value = "";
  const droppedFiles = await extractDroppedBatchImportFiles(event.dataTransfer);
  const plan = planBatchImportDrop(droppedFiles, batch.value.mode);
  if (!plan.accepted) {
    dropError.value = t("batchImport.dropUnsupportedError");
    return;
  }
  if (plan.skippedCount > 0) {
    dropNotice.value = t("batchImport.dropSkippedNonExcel", { count: plan.skippedCount });
  }
  emit("files-dropped", { files: plan.files, mode: plan.mode });
}

watch(
  () => batch.value.open,
  (open) => {
    resetDragState();
    dropError.value = "";
    dropNotice.value = "";
    if (open) {
      query.value = "";
      viewMode.value = "scope";
      comparisonFullscreen.value = false;
    }
  },
);

watch(canAcceptDrop, (allowed) => {
  if (!allowed) resetDragState();
});

watch(
  () => batch.value.comparison.status,
  (status) => {
    if (status === "idle") viewMode.value = "scope";
    else if (["succeeded", "partial", "cancelled"].includes(status)) viewMode.value = "comparison";
  },
);

const dialogStyle = computed(() => {
  if (!frame.value) {
    return {
      position: "absolute",
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
    };
  }
  return {
    position: "absolute",
    left: `${frame.value.left}px`,
    top: `${frame.value.top}px`,
    width: `${frame.value.width}px`,
    height: `${frame.value.height}px`,
    maxWidth: "none",
    maxHeight: "none",
    transform: "none",
  };
});

function viewportSize() {
  return {
    width: globalThis.innerWidth || 0,
    height: globalThis.innerHeight || 0,
  };
}

{
  const openingViewport = viewportSize();
  const openingPlacement = readBatchImportDialogPlacement(globalThis.localStorage, openingViewport);
  frame.value = openingPlacement.frame;
  userPositioned = openingPlacement.positioned;
  placedViewport = openingPlacement.frame ? openingViewport : null;
}

function persistFrame(next = frame.value) {
  if (!next) return;
  const viewport = viewportSize();
  frame.value = next;
  placedViewport = viewport;
  saveBatchImportDialogFrame({ ...next, positioned: userPositioned }, globalThis.localStorage, viewport);
}

function keepFrameInViewport() {
  if (!frame.value || resizing.value || moving.value) return;
  const viewport = viewportSize();
  if (!dialogViewportMatches(placedViewport, viewport)) {
    frame.value = centerDialogFrame(frame.value, viewport);
    placedViewport = viewport;
    userPositioned = false;
    return;
  }
  frame.value = clampDialogFrame(frame.value, viewport);
}

function readDialogFrame() {
  const dialog = dialogRef.value;
  if (!dialog?.getBoundingClientRect) return frame.value;
  const rect = dialog.getBoundingClientRect();
  const host = dialog.parentElement?.getBoundingClientRect?.() || { left: 0, top: 0 };
  return {
    left: rect.left - host.left,
    top: rect.top - host.top,
    width: rect.width,
    height: rect.height,
  };
}

function resizeCursor(edges) {
  const vertical = Boolean(edges.top || edges.bottom);
  const horizontal = Boolean(edges.left || edges.right);
  if (vertical && horizontal) return edges.top === edges.left ? "nwse-resize" : "nesw-resize";
  return horizontal ? "ew-resize" : "ns-resize";
}

let stopResize = null;
let stopMove = null;

function startResize(event, edges) {
  if (event.button != null && event.button !== 0) return;
  const origin = readDialogFrame();
  if (!origin?.width || !origin?.height) return;
  event.preventDefault();
  event.stopPropagation();
  stopMove?.();
  stopResize?.();
  const startPoint = { x: event.clientX, y: event.clientY };
  const pointerId = event.pointerId;
  const handle = event.currentTarget;
  resizing.value = true;
  try {
    handle?.setPointerCapture?.(pointerId);
  } catch {
    // Pointer capture is unavailable for this event; window listeners still track the drag.
  }
  if (globalThis.document?.body) {
    globalThis.document.body.style.cursor = resizeCursor(edges);
    globalThis.document.body.style.userSelect = "none";
  }
  const move = (moveEvent) => {
    const samples = moveEvent.getCoalescedEvents?.();
    const latest = samples?.length ? samples[samples.length - 1] : moveEvent;
    frame.value = resizeDialogFrame(origin, {
      x: latest.clientX - startPoint.x,
      y: latest.clientY - startPoint.y,
    }, edges, viewportSize());
  };
  const stop = () => {
    globalThis.removeEventListener?.("pointermove", move);
    globalThis.removeEventListener?.("pointerup", stop);
    globalThis.removeEventListener?.("pointercancel", stop);
    handle?.removeEventListener?.("lostpointercapture", stop);
    if (handle?.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    resizing.value = false;
    if (globalThis.document?.body) {
      globalThis.document.body.style.cursor = "";
      globalThis.document.body.style.userSelect = "";
    }
    persistFrame();
    if (stopResize === stop) stopResize = null;
  };
  stopResize = stop;
  globalThis.addEventListener?.("pointermove", move);
  globalThis.addEventListener?.("pointerup", stop);
  globalThis.addEventListener?.("pointercancel", stop);
  handle?.addEventListener?.("lostpointercapture", stop);
}

function startMove(event) {
  if (event.button != null && event.button !== 0) return;
  if (event.target?.closest?.("button, a, input, select, textarea, label")) return;
  const origin = readDialogFrame();
  if (!origin?.width || !origin?.height) return;
  event.preventDefault();
  stopResize?.();
  stopMove?.();
  const startPoint = { x: event.clientX, y: event.clientY };
  const pointerId = event.pointerId;
  const handle = event.currentTarget;
  userPositioned = true;
  moving.value = true;
  try {
    handle?.setPointerCapture?.(pointerId);
  } catch {
    // Pointer capture is unavailable for this event; window listeners still track the drag.
  }
  if (globalThis.document?.body) {
    globalThis.document.body.style.cursor = "grabbing";
    globalThis.document.body.style.userSelect = "none";
  }
  const move = (moveEvent) => {
    const samples = moveEvent.getCoalescedEvents?.();
    const latest = samples?.length ? samples[samples.length - 1] : moveEvent;
    frame.value = moveDialogFrame(origin, {
      x: latest.clientX - startPoint.x,
      y: latest.clientY - startPoint.y,
    }, viewportSize());
  };
  const stop = () => {
    globalThis.removeEventListener?.("pointermove", move);
    globalThis.removeEventListener?.("pointerup", stop);
    globalThis.removeEventListener?.("pointercancel", stop);
    handle?.removeEventListener?.("lostpointercapture", stop);
    if (handle?.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    moving.value = false;
    if (globalThis.document?.body) {
      globalThis.document.body.style.cursor = "";
      globalThis.document.body.style.userSelect = "";
    }
    persistFrame();
    if (stopMove === stop) stopMove = null;
  };
  stopMove = stop;
  globalThis.addEventListener?.("pointermove", move);
  globalThis.addEventListener?.("pointerup", stop);
  globalThis.addEventListener?.("pointercancel", stop);
  handle?.addEventListener?.("lostpointercapture", stop);
}

onMounted(() => {
  globalThis.addEventListener?.("resize", keepFrameInViewport);
  globalThis.addEventListener?.("dragend", resetDragState);
  globalThis.addEventListener?.("blur", resetDragState);
});

onBeforeUnmount(() => {
  stopResize?.();
  stopMove?.();
  resetDragState();
  globalThis.removeEventListener?.("resize", keepFrameInViewport);
  globalThis.removeEventListener?.("dragend", resetDragState);
  globalThis.removeEventListener?.("blur", resetDragState);
});
</script>

<template>
  <div
    class="wb-dialog-overlay"
    @dragenter="onOverlayDragEnter"
    @dragover="onOverlayDragOver"
    @dragleave="onOverlayDragLeave"
    @drop="onOverlayDrop"
  >
    <section
      ref="dialogRef"
      class="wb-dialog wb-batch-transfer-dialog wb-batch-import-dialog"
      :class="{
        'is-comparison-mode': viewMode === 'comparison',
        'is-user-sized': frame != null,
        'is-resizing': resizing,
        'is-moving': moving,
        'is-file-dragging': draggingFile && canAcceptDrop,
      }"
      :style="dialogStyle"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wb-batch-import-title"
      tabindex="-1"
    >
      <header class="wb-dialog-header" @pointerdown="startMove">
        <div>
          <strong id="wb-batch-import-title">{{ t('m_fd7719273970') }}</strong>
          <small>{{ batch.database }}</small>
        </div>
        <button type="button" class="wb-dialog-close" :disabled="isBusy" :aria-label="t('m_0f5e47d36b9c')" @click="emit('close')">
          <X :size="16" aria-hidden="true" />
        </button>
      </header>

      <div class="wb-batch-mode-switch" role="radiogroup" :aria-label="t('m_8d8a776d9ff2')">
        <button
          v-for="option in modeOptions"
          :key="option.value"
          type="button"
          :class="{ 'is-active': batch.mode === option.value }"
          :disabled="isBusy"
          :aria-checked="batch.mode === option.value"
          role="radio"
          @click="selectMode(option.value)"
        >
          {{ option.label }}
        </button>
      </div>

      <button
        type="button"
        class="wb-batch-file-drop"
        :class="{
          'is-empty': !hasLoadedFile,
          'has-file': hasLoadedFile,
          'is-dragging': draggingFile && canAcceptDrop && !hasLoadedFile,
        }"
        :disabled="isBusy"
        @click="fileInput?.click()"
      >
        <template v-if="!hasLoadedFile">
          <span class="wb-batch-file-drop-icon" aria-hidden="true">
            <FileUp :size="22" />
          </span>
          <strong class="wb-batch-file-drop-title">
            {{ draggingFile && canAcceptDrop ? t('batchImport.dropRelease') : filePrompt }}
          </strong>
          <small class="wb-batch-file-drop-hint">{{ fileDropHint }}</small>
        </template>
        <template v-else>
          <span class="wb-batch-file-drop-file">
            <FileSpreadsheet :size="16" aria-hidden="true" />
            <span class="wb-batch-file-drop-name">{{ batch.fileName }}</span>
          </span>
          <small class="wb-batch-file-drop-replace">{{ t('batchImport.replaceHint') }}</small>
        </template>
      </button>
      <p v-if="dropError" class="wb-dialog-error" role="alert">{{ dropError }}</p>
      <p v-if="dropNotice" class="wb-import-info" role="status">{{ dropNotice }}</p>
      <p v-if="batch.ignoredSheetCount" class="wb-import-info" role="status"> {{ t('m_d1ff9f3343ad') }} {{ batch.ignoredSheetCount }} {{ t('m_a2710571dfe3') }} </p>
      <input
        ref="fileInput"
        type="file"
        accept=".xlsx,.xls"
        :multiple="batch.mode === 'separate'"
        style="display: none"
        :disabled="isBusy"
        @change="onFileInputChange"
      />

      <div v-if="comparisonAvailable" class="wb-batch-import-view-switch" role="tablist" :aria-label="t('m_31644d74d930')">
        <button
          type="button"
          role="tab"
          :class="{ 'is-active': viewMode === 'scope' }"
          :aria-selected="viewMode === 'scope'"
          @click="viewMode = 'scope'"
        > {{ t('m_8c99578d0d05') }} </button>
        <button
          type="button"
          role="tab"
          :class="{ 'is-active': viewMode === 'comparison' }"
          :aria-selected="viewMode === 'comparison'"
          @click="viewMode = 'comparison'"
        > {{ t('m_745edd3e58e9') }} <span>{{ comparisonChangeCount }}</span>
        </button>
      </div>

      <div v-if="viewMode === 'scope' && hasLoadedFile" class="wb-batch-transfer-toolbar">
        <label class="wb-batch-transfer-check">
          <input v-model="allSelected" type="checkbox" :disabled="isBusy || !batch.sheets.length" />
          <span>{{ t('m_7ca9de237a29') }}</span>
        </label>
        <input v-model="query" type="text" :placeholder="searchPlaceholder" :disabled="isBusy || !batch.sheets.length" />
        <span>{{ t('m_7ecf1cde6486') }} {{ selectedCount }} {{ t('m_1263443e3785') }} {{ matchedSheets }}</span>
      </div>

      <div v-if="viewMode === 'scope' && hasLoadedFile && filteredSheets.length" class="wb-batch-transfer-list">
        <label v-for="sheet in filteredSheets" :key="sheet.sheetName" class="wb-batch-transfer-row is-import-row">
          <input
            type="checkbox"
            :checked="batch.selectedSheetNames.has(sheet.sheetName)"
            :disabled="isBusy || !sheet.targetTableName || !sheet.headers.some((header) => String(header || '').trim())"
            @change="transfer.toggleImportSheet(sheet.sheetName)"
          />
          <span class="wb-batch-transfer-name">
            {{ sheet.sheetName }}
            <small v-if="batch.mode === 'separate' && sheet.workbookSheetName">{{ sheet.workbookSheetName }}</small>
          </span>
          <select
            :value="sheet.targetTableName"
            :disabled="isBusy"
            @change="transfer.setImportSheetTarget(sheet.sheetName, $event.target.value)"
          >
            <option value="">{{ t('m_fc50a99caae0') }}</option>
            <option v-for="tableName in targetTables" :key="tableName" :value="tableName">{{ tableName }}</option>
          </select>
          <span class="wb-batch-transfer-comment">{{ sheet.rowCount }} {{ t('m_4cc7b00050cb') }}</span>
          <span class="wb-batch-transfer-state" :class="`is-${sheet.status}`" :title="sheet.message || sheet.status">{{ sheet.message || sheet.status }}</span>
        </label>
      </div>
      <div v-else-if="viewMode === 'scope' && hasLoadedFile && batch.status !== 'reading'" class="wb-batch-transfer-empty">
        {{ batch.mode === "separate" ? t('m_a7ad4c5e0dd9') : t('m_30255b8d4191') }}
      </div>

      <BatchImportComparison
        v-else-if="viewMode === 'comparison'"
        :comparison="batch.comparison"
        @fullscreen-change="comparisonFullscreen = $event"
      />

      <div v-if="showDropCover" class="wb-batch-import-drop-overlay" aria-hidden="true">
        <div class="wb-batch-import-drop-card">
          <span class="wb-batch-file-drop-icon">
            <FileUp :size="24" />
          </span>
          <strong>{{ t('batchImport.dropReleaseReplace') }}</strong>
          <small>{{ t('batchImport.dropOverlayHint') }}</small>
        </div>
      </div>

      <section v-if="isBusy || currentProgress.total > 0" class="wb-batch-transfer-progress">
        <div class="wb-batch-transfer-progress-line">
          <span :style="{ width: progressPercent + '%' }"></span>
        </div>
        <p>
          <strong v-if="currentProgress.phase">{{ currentProgress.phase }}</strong>
          <span>{{ currentProgress.done }} / {{ currentProgress.total }}</span>
          <template v-if="currentProgress.current">· {{ currentProgress.current }}</template>
        </p>
      </section>

      <section v-if="batch.result" class="wb-batch-result-summary wb-batch-import-summary" :class="`is-${batch.status}`" role="status" aria-live="polite">
        <div><strong>{{ batch.result.inserted }}</strong><span>{{ t('m_0006d696d8e1') }}</span></div>
        <div><strong>{{ batch.result.updated }}</strong><span>{{ t('m_3055a035f0eb') }}</span></div>
        <div><strong>{{ batch.result.deleted }}</strong><span>{{ t('m_2f9daa828907') }}</span></div>
        <div><strong>{{ batch.result.unchanged }}</strong><span>{{ t('m_43d477cc5ddb') }}</span></div>
        <div><strong>{{ batch.result.skipped }}</strong><span>{{ t('m_fc50a99caae0') }}</span></div>
        <div><strong>{{ batch.result.errors.length }}</strong><span>{{ t('m_28384d7afd2e') }}</span></div>
      </section>

      <p v-if="batch.status === 'failed'" class="wb-dialog-error">{{ batch.errorMessage }}</p>
      <p v-if="batch.progress.errors.length" class="wb-batch-transfer-warning">
        {{ batch.progress.errors.length }} {{ t('m_31a024a6af1d') }} </p>

      <footer class="wb-dialog-actions wb-batch-transfer-actions">
        <button
          v-if="batch.progress.errors.length"
          type="button"
          :disabled="isBusy"
          @click="transfer.exportBatchImportErrors()"
        > {{ t('m_a4984fdbb494') }} </button>
        <button type="button" :disabled="isBusy" @click="emit('close')">{{ t('m_3fd47edce45b') }}</button>
        <button
          v-if="batch.comparison.running"
          type="button"
          :disabled="batch.comparison.cancelRequested"
          @click="transfer.cancelBatchImportComparison()"
        >
          {{ batch.comparison.cancelRequested ? t('m_e8e08b0f61dd') : t('m_715bbfc14da2') }}
        </button>
        <button
          v-if="batch.importing"
          type="button"
          :disabled="batch.cancelRequested"
          @click="transfer.cancelBatchImport()"
        >
          {{ batch.cancelRequested ? t('m_e8e08b0f61dd') : t('m_26bff7125c63') }}
        </button>
        <button
          v-else-if="!batch.comparison.running"
          type="button"
          class="wb-batch-compare-action"
          :disabled="!transfer.canCompareBatchImport.value"
          @click="transfer.compareBatchImportChanges()"
        >
          <GitCompareArrows :size="15" aria-hidden="true" />
          {{ comparisonAvailable ? t('m_1e4cfe2a5930') : t('m_c9b3a8e7059a') }}
        </button>
        <button
          v-if="!batch.importing && !batch.comparison.running"
          type="button"
          class="wb-dialog-primary"
          :disabled="!transfer.canExecuteBatchImport.value"
          @click="emit('execute')"
        >
          {{ importButtonLabel }}
        </button>
      </footer>
      <span
        v-for="handle in resizeHandles"
        :key="handle.edge"
        class="wb-batch-import-resize"
        :class="`is-${handle.edge}`"
        role="separator"
        :aria-label="handle.label"
        :aria-orientation="handle.orientation"
        @pointerdown="startResize($event, handle.edges)"
      />
    </section>
  </div>
</template>
