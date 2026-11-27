<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ArrowDown, ArrowUp, KeyRound, Plus, Trash2 } from "lucide-vue-next";

import { useTableDesign } from "../composables/useTableDesign.js";
import { useEscClose } from "../composables/useEscClose.js";
import WorkbenchSelect from "./WorkbenchSelect.vue";
import {
  DEFAULT_CHARSET_OPTIONS,
  INDEX_TYPES,
  MYSQL_COMMON_TYPES,
  MYSQL_ENGINES,
  getTypeDefaultLength,
  typeSupportsAutoIncrement,
  typeSupportsUnsigned,
} from "../utils/tableDesign.js";
import {
  hasEditableTextSelection,
  resolveTableDesignClipboard,
  serializeTableDesignColumns,
  setTableDesignClipboard,
} from "../utils/tableDesignClipboard.js";

const props = defineProps({
  source: {
    type: Object,
    required: true,
  },
  invokeWorkbench: {
    type: Function,
    required: true,
  },
  isFocused: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["applied"]);

const {
  creating,
  loading,
  previewing,
  saving,
  error,
  draft,
  dirty,
  validationErrors,
  preview,
  previewOpen,
  loadDesign,
  resetDraft,
  previewDesign,
  cancelPreview,
  applyDesign,
  dispose,
  addColumn,
  snapshotColumns,
  pasteColumns,
  removeColumn,
  togglePrimaryKey,
  toggleAutoIncrement,
  addIndex,
  removeIndex,
  addIndexColumn,
  removeIndexColumn,
  moveIndexColumn,
  isNewColumn,
} = useTableDesign(props.invokeWorkbench, computed(() => props.source), {
  onApplied: (event) => emit("applied", event),
});

const activeTab = ref("columns");
const charsetOptions = ref(DEFAULT_CHARSET_OPTIONS);
let charsetLoadToken = 0;

async function loadServerCharsets() {
  const connectionId = String(props.source?.connectionId || props.source?.connection_id || "");
  if (!connectionId) return;
  const token = ++charsetLoadToken;
  try {
    const result = await props.invokeWorkbench("list_server_charsets", { connectionId });
    if (token !== charsetLoadToken) return;
    if (Array.isArray(result) && result.length) {
      charsetOptions.value = result;
    }
  } catch {
    // Fallback list remains active if server charset list is unavailable.
  }
}

const availableCollations = computed(() => {
  const current = String(draft.charset || "").trim().toLowerCase();
  const matched = charsetOptions.value.find((item) => item.charset.toLowerCase() === current);
  if (matched?.collations?.length) return matched.collations;
  if (draft.collation) return [draft.collation];
  return [];
});

function onCharsetChange(nextCharset) {
  draft.charset = nextCharset;
  const matched = charsetOptions.value.find((item) => item.charset.toLowerCase() === String(nextCharset || "").toLowerCase());
  if (matched) {
    draft.collation = matched.defaultCollation || matched.collations?.[0] || "";
  }
}

const availableColumnNames = computed(() =>
  draft.columns.map((c) => String(c.name || "").trim()).filter(Boolean),
);

function unusedColumnsForIndex(indexItem) {
  const used = new Set((indexItem.columns || []).map((c) => String(c || "").toLowerCase()));
  return availableColumnNames.value.filter((name) => !used.has(name.toLowerCase()));
}

function onAppendIndexColumn(indexItem, valueOrEvent) {
  const value = typeof valueOrEvent === "string" ? valueOrEvent : (valueOrEvent?.target?.value || "");
  if (value) addIndexColumn(indexItem, value);
  if (valueOrEvent?.target) valueOrEvent.target.value = "";
}

const sourceTitle = computed(() => {
  if (creating.value) return [props.source?.database, draft.tableName].filter(Boolean).join(".");
  const database = props.source?.database ? `${props.source.database}.` : "";
  return `${database}${props.source?.tableName || props.source?.table_name || props.source?.name || ""}`;
});

const hasValidationMessages = computed(() => validationErrors.value?.valid === false);

const previewHasConflicts = computed(() => (preview.value?.conflicts?.length || 0) > 0);

const successMessage = ref("");
const successToastId = ref(0);
let successTimer = null;

function showSuccess(msg) {
  successMessage.value = msg;
  successToastId.value += 1;
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => { successMessage.value = ""; }, 1300);
}

const sourceKey = computed(() => [
  props.source?.connectionId || props.source?.connection_id || "",
  props.source?.database || "",
  props.source?.tableName || props.source?.table_name || props.source?.name || "",
].join("\u001F"));

async function refreshDesign({ notify = true } = {}) {
  try {
    await loadDesign({ force: true });
    if (notify) showSuccess("已刷新表设计");
  } catch {
    // Error text is already exposed through the composable state.
  }
}

async function handlePreview() {
  if (previewing.value) {
    cancelPreview();
    return;
  }
  try {
    await previewDesign();
  } catch {
    // Error text is already exposed through the composable state.
  }
}

async function handleSave() {
  await handlePreview();
}

async function handleConfirmApply() {
  const wasCreating = creating.value;
  try {
    const result = await applyDesign();
    if (!result) return;
    previewOpen.value = false;
    showSuccess(wasCreating ? t("createTable.created") : "表设计保存成功");
  } catch {
    // Error text is already exposed through the composable state.
  }
}

/* ---------- 导出报错信息 ---------- */
async function exportErrors() {
  const parts = [];
  parts.push("===== 表设计报错信息 =====");
  parts.push("生成时间：" + new Date().toLocaleString("zh-CN"));
  parts.push("");

  if (error.value) {
    parts.push("【实时错误】");
    parts.push(error.value);
    parts.push("");
  }

  if (preview.value?.conflicts?.length) {
    parts.push("【冲突（阻止保存）】");
    preview.value.conflicts.forEach((c, i) => parts.push(`  ${i + 1}. ${c}`));
    parts.push("");
  }

  if (preview.value?.warnings?.length) {
    parts.push("【警告】");
    preview.value.warnings.forEach((w, i) => parts.push(`  ${i + 1}. ${w}`));
    parts.push("");
  }

  if (validationErrors.value?.messages?.length) {
    parts.push("【校验错误】");
    validationErrors.value.messages.forEach((m, i) => parts.push(`  ${i + 1}. ${m}`));
    parts.push("");
  }

  if (parts.length <= 5) {
    parts.push("（没有检测到报错信息）");
  }

  const content = parts.join("\n");
  const fileName = `表设计报错_${new Date().toISOString().slice(0, 10)}.txt`;
  try {
    await props.invokeWorkbench("save_text_file", { fileName, content });
  } catch {
    // 用户取消保存，不需要提示
  }
}

const editorRef = ref(null);
const tableNameInput = ref(null);
const selectedIndexes = ref([]);
const selectionAnchor = ref(null);

function isSelected(index) {
  return selectedIndexes.value.includes(index);
}

function lastSelectedIndex() {
  if (!selectedIndexes.value.length) return null;
  return Math.max(...selectedIndexes.value);
}

function selectRow(index, event) {
  const shift = Boolean(event?.shiftKey);
  const ctrl = Boolean(event?.ctrlKey || event?.metaKey);
  if (shift && selectionAnchor.value != null) {
    const start = Math.min(selectionAnchor.value, index);
    const end = Math.max(selectionAnchor.value, index);
    selectedIndexes.value = Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
  } else if (ctrl) {
    selectedIndexes.value = isSelected(index)
      ? selectedIndexes.value.filter((item) => item !== index)
      : [...selectedIndexes.value, index].sort((left, right) => left - right);
    selectionAnchor.value = index;
  } else {
    selectedIndexes.value = [index];
    selectionAnchor.value = index;
  }
  if (!event?.target?.closest?.("input, textarea, select, button")) {
    editorRef.value?.focus({ preventScroll: true });
  }
}

function onRowPointerDown(index, event) {
  if (event.target?.closest?.("input, textarea, select, button")) return;
  selectRow(index, event);
}

function onFieldFocus(index) {
  if (!isSelected(index)) {
    selectedIndexes.value = [index];
    selectionAnchor.value = index;
  }
}

async function readClipboardText() {
  try {
    const fromInvoke = await props.invokeWorkbench("read_clipboard_text");
    if (fromInvoke != null && String(fromInvoke) !== "") return String(fromInvoke);
  } catch {
    // Browser mock and older runtimes fall back to the Clipboard API.
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

async function writeClipboardText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Internal clipboard still lets the user paste into another design tab.
  }
}

function isEditableClipboardTarget(target) {
  return Boolean(target?.closest?.("input, textarea, [contenteditable='true']"));
}

function shouldHandleClipboardShortcut(event) {
  if (commentDialog.open || previewOpen.value || activeTab.value !== "columns") return false;
  if (editorRef.value?.contains?.(event?.target)) return true;
  if (!props.isFocused) return false;
  const pane = editorRef.value?.closest?.(".wb-workbench-pane");
  if (pane?.contains?.(event?.target)) return true;
  const target = event?.target;
  return !target || target === document || target === document.body || target === document.documentElement;
}

function applyPastedColumns(columns) {
  if (!columns?.length) return false;
  const afterIndex = lastSelectedIndex();
  const pasted = pasteColumns(columns, { afterIndex });
  if (!pasted.length) return false;
  const start = afterIndex == null ? draft.columns.length - pasted.length : afterIndex + 1;
  selectedIndexes.value = pasted.map((_, offset) => start + offset);
  selectionAnchor.value = selectedIndexes.value.at(-1) ?? null;
  showSuccess(`已粘贴 ${pasted.length} 个字段`);
  return true;
}

async function copySelectedColumns(event) {
  if (hasEditableTextSelection(event?.target)) return false;
  const columns = snapshotColumns(selectedIndexes.value);
  if (!columns.length) return false;
  event?.preventDefault?.();
  const text = serializeTableDesignColumns(columns);
  event?.clipboardData?.setData?.("text/plain", text);
  setTableDesignClipboard(text, columns);
  showSuccess(`已复制 ${columns.length} 个字段`);
  if (!event?.clipboardData) await writeClipboardText(text);
  return true;
}

async function pasteCopiedColumns(event) {
  if (loading.value || previewing.value || saving.value) return false;
  const fromEvent = event?.clipboardData?.getData?.("text/plain");
  let parsed = resolveTableDesignClipboard(fromEvent ?? "", {
    allowInternalFallback: fromEvent == null || fromEvent === "",
  });
  if (!parsed && fromEvent == null) {
    parsed = resolveTableDesignClipboard(await readClipboardText(), { allowInternalFallback: true });
  }
  if (!parsed) return false;
  event?.preventDefault?.();
  return applyPastedColumns(parsed.columns);
}

function onCopy(event) {
  if (!shouldHandleClipboardShortcut(event)) return;
  void copySelectedColumns(event);
}

function onPaste(event) {
  if (!shouldHandleClipboardShortcut(event)) return;
  void pasteCopiedColumns(event);
}

/* ---------- Ctrl+S / 字段复制粘贴 ---------- */
function onKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    if (dirty.value && !loading.value && !previewing.value && !saving.value) {
      handleSave();
    }
    return;
  }
  if (!shouldHandleClipboardShortcut(e)) return;
  const key = String(e.key || "").toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === "c") {
    if (hasEditableTextSelection(e.target)) return;
    if (!selectedIndexes.value.length) return;
    e.preventDefault();
    void copySelectedColumns(e);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && key === "v") {
    if (isEditableClipboardTarget(e.target)) return;
    e.preventDefault();
    void pasteCopiedColumns();
  }
}

watch(() => draft.columns.length, (length) => {
  selectedIndexes.value = selectedIndexes.value.filter((index) => index >= 0 && index < length);
  if (selectionAnchor.value != null && (selectionAnchor.value < 0 || selectionAnchor.value >= length)) {
    selectionAnchor.value = selectedIndexes.value.at(-1) ?? null;
  }
});

document.addEventListener("keydown", onKeydown);
document.addEventListener("copy", onCopy, true);
document.addEventListener("paste", onPaste, true);
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  document.removeEventListener("copy", onCopy, true);
  document.removeEventListener("paste", onPaste, true);
  if (successTimer) clearTimeout(successTimer);
  dispose();
});
const previewDialogRef = ref(null);

function closePreviewDialog() {
  if (saving.value) return;
  previewOpen.value = false;
}

useEscClose(
  () => previewOpen.value,
  closePreviewDialog,
  () => saving.value,
  { dialogRef: previewDialogRef },
);

function clearRowSelection() {
  selectedIndexes.value = [];
  selectionAnchor.value = null;
}

onMounted(async () => {
  await refreshDesign({ notify: false });
  void loadServerCharsets();
  await nextTick();
  if (creating.value && props.isFocused) tableNameInput.value?.focus();
});
watch(sourceKey, () => {
  clearRowSelection();
  activeTab.value = "columns";
  refreshDesign({ notify: false });
  void loadServerCharsets();
});

/* ---------- Column resizing ---------- */
const defaultColWidths = {
  select: 34,
  name: 140,
  primaryKey: 68,
  type: 112,
  length: 62,
  scale: 54,
  unsigned: 54,
  autoIncrement: 54,
  nullable: 62,
  defaultMode: 84,
  defaultValue: 92,
  comment: 170,
  actions: 48,
};

const SCALE_SUPPORTED_TYPES = new Set(["DECIMAL", "NUMERIC", "FLOAT", "DOUBLE"]);
function typeSupportsScale(typeValue) {
  return SCALE_SUPPORTED_TYPES.has(String(typeValue || "").trim().toUpperCase());
}

const colWidths = reactive({ ...defaultColWidths });
const resizingCol = ref(null);
const resizeStartX = ref(0);
const resizeStartWidth = ref(0);

function startResize(colKey, event) {
  resizingCol.value = colKey;
  resizeStartX.value = event.clientX;
  resizeStartWidth.value = colWidths[colKey];
  document.addEventListener("mousemove", onResizeMove);
  document.addEventListener("mouseup", onResizeEnd);
  event.preventDefault();
}

function onResizeMove(event) {
  if (!resizingCol.value) return;
  const delta = event.clientX - resizeStartX.value;
  const newWidth = Math.max(46, resizeStartWidth.value + delta);
  colWidths[resizingCol.value] = newWidth;
}

function onResizeEnd() {
  resizingCol.value = null;
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeEnd);
}

/* ---------- Type dropdown + auto length ---------- */
function onTypeChange(column, typeValue) {
  column.type = typeValue;
  if (!typeSupportsUnsigned(typeValue)) column.unsigned = false;
  if (!typeSupportsAutoIncrement(typeValue)) column.autoIncrement = false;
  const defaultLen = getTypeDefaultLength(typeValue);
  if (defaultLen) {
    if (defaultLen.includes(",")) {
      const [len, scale] = defaultLen.split(",");
      column.length = len;
      column.scale = scale;
    } else {
      column.length = defaultLen;
      column.scale = "";
    }
  } else {
    column.length = "";
    column.scale = "";
  }
}

function primaryKeyLabel(column) {
  return column.primaryKey ? `主键 ${column.primaryKeyOrdinal}` : "设为主键";
}

function primaryKeyTitle(column) {
  if (column.primaryKey) {
    return `主键 ${column.primaryKeyOrdinal}；点击取消，其他主键将自动重新编号`;
  }
  const nextOrdinal = draft.columns.filter((candidate) => candidate.primaryKey).length + 1;
  return `设为主键 ${nextOrdinal}`;
}

/* ---------- Row drag reorder ---------- */
const dragIndex = ref(null);
const dragOverIndex = ref(null);

function onDragStart(index, event) {
  dragIndex.value = index;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  }
}

function onDragOver(index, event) {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
  dragOverIndex.value = index;
}

function onDragLeave() {
  dragOverIndex.value = null;
}

function onDrop(targetIndex) {
  const sourceIdx = dragIndex.value;
  if (sourceIdx === null || sourceIdx === targetIndex) {
    dragIndex.value = null;
    dragOverIndex.value = null;
    return;
  }
  const cols = draft.columns;
  const [moved] = cols.splice(sourceIdx, 1);
  cols.splice(targetIndex, 0, moved);
  dragIndex.value = null;
  dragOverIndex.value = null;
}

function onDragEnd() {
  dragIndex.value = null;
  dragOverIndex.value = null;
}

/* ---------- Comment dialog ---------- */
const commentDialog = reactive({
  open: false,
  columnIndex: -1,
  value: "",
});
const commentDialogRef = ref(null);

function openCommentDialog(columnIndex) {
  commentDialog.columnIndex = columnIndex;
  commentDialog.value = draft.columns[columnIndex]?.comment || "";
  commentDialog.open = true;
}

function closeCommentDialog(save) {
  if (save && commentDialog.columnIndex >= 0) {
    draft.columns[commentDialog.columnIndex].comment = commentDialog.value;
  }
  commentDialog.open = false;
  commentDialog.columnIndex = -1;
  commentDialog.value = "";
}

useEscClose(
  () => commentDialog.open,
  () => closeCommentDialog(false),
  null,
  { dialogRef: commentDialogRef },
);

/* Simple markdown renderer */
function renderMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);

  html = html.replace(/^###### (.*$)/gim, "<h6>$1</h6>");
  html = html.replace(/^##### (.*$)/gim, "<h5>$1</h5>");
  html = html.replace(/^#### (.*$)/gim, "<h4>$1</h4>");
  html = html.replace(/^### (.*$)/gim, "<h3>$1</h3>");
  html = html.replace(/^## (.*$)/gim, "<h2>$1</h2>");
  html = html.replace(/^# (.*$)/gim, "<h1>$1</h1>");

  html = html.replace(/\*\*\*(.*?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
  html = html.replace(/___(.*?)___/g, "<strong><em>$1</em></strong>");
  html = html.replace(/__(.*?)__/g, "<strong>$1</strong>");
  html = html.replace(/_(.*?)_/g, "<em>$1</em>");

  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%;border-radius:4px;" />');
  html = html.replace(/^---$/gim, "<hr />");
  html = html.replace(/^\*\*\*$/gim, "<hr />");
  html = html.replace(/^&gt; (.*$)/gim, "<blockquote>$1</blockquote>");
  html = html.replace(/^\- (.*$)/gim, "<li>$1</li>");
  html = html.replace(/^(<li>.*<\/li>\n?)+/gm, (match) => `<ul>${match}</ul>`);
  html = html.replace(/^\d+\.\s+(.*$)/gim, "<li>$1</li>");
  html = html.replace(/^(?!<[hou]|<li|<block|<hr|<pre|<img)(.+)$/gim, "<p>$1</p>");
  html = html.replace(/<p><\/p>/g, "");

  return html;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

const commentPreviewHtml = computed(() => renderMarkdown(commentDialog.value));

/* ---------- Column definition for rendering ---------- */
const colDefs = [
  { key: "name", labelKey: "design.column.name" },
  { key: "primaryKey", labelKey: "design.column.primaryKey" },
  { key: "type", labelKey: "design.column.type" },
  { key: "length", labelKey: "design.column.length" },
  { key: "scale", labelKey: "design.column.scale" },
  { key: "unsigned", labelKey: "design.column.unsigned" },
  { key: "autoIncrement", labelKey: "design.column.autoIncrement" },
  { key: "nullable", labelKey: "design.column.nullable" },
  { key: "defaultMode", labelKey: "design.column.defaultMode" },
  { key: "defaultValue", labelKey: "design.column.defaultValue" },
  { key: "comment", labelKey: "design.column.comment" },
  { key: "actions", labelKey: "design.column.actions" },
];
</script>

<template>
  <section
    ref="editorRef"
    class="wb-design-editor"
    :aria-label="creating ? t('createTable.title') : t('m_b5b964561870')"
    tabindex="-1"
  >
    <div class="wb-design-toast-layer" aria-live="polite" aria-atomic="true">
      <span
        v-if="successMessage"
        :key="successToastId"
        class="wb-save-reminder is-success"
        role="status"
      >{{ successMessage }}</span>
    </div>
    <header class="wb-design-header">
      <div class="wb-design-title">
        <strong>{{ creating ? t('createTable.title') : t('m_d9a122ddc940') }}</strong>
        <span :title="sourceTitle">{{ sourceTitle }}</span>
        <em v-if="dirty" class="wb-design-dirty">{{ t('m_6a1be012c99c') }}</em>
      </div>
      <div class="wb-design-actions">
        <button v-if="!creating" type="button" :disabled="loading || previewing || saving" @click="refreshDesign">{{ t('m_aee887434131') }}</button>
        <button type="button" :disabled="loading || previewing || saving || !dirty" @click="resetDraft">{{ t('m_cb5d682bac3d') }}</button>
        <button type="button" :disabled="loading || saving" @click="handlePreview">{{ previewing ? t('m_4e7a87eb2805') : t('m_5b294b6e8ed8') }}</button>
        <button type="button" class="wb-design-primary" :disabled="loading || previewing || saving || !dirty" @click="handleSave">{{ creating ? t('createTable.review') : previewing ? t('m_93108108fea5') : t('m_a3030bf8f16d') }}</button>
      </div>
    </header>

    <div v-if="loading" class="wb-design-state">{{ t('m_3f6fb13a558d') }}</div>
    <div v-else class="wb-design-body" :inert="saving || undefined">
      <p v-if="previewing" class="wb-design-state" role="status" aria-live="polite">{{ t('m_66642c2f5c7c') }}</p>
      <p v-if="error" class="wb-design-error" role="alert">{{ error }}</p>
      <div v-if="previewHasConflicts" class="wb-design-conflict-banner" role="alert">
        <strong>{{ t('m_842a962155a6') }}</strong>
        <span>{{ t('m_e4c5dd0ccf6a') }}</span>
      </div>
      <div v-if="hasValidationMessages" class="wb-design-validation" role="alert">
        <strong>{{ t('m_d5079872e308') }}</strong>
        <span v-for="message in validationErrors.messages" :key="message">{{ message }}</span>
      </div>

      <label v-if="creating" class="wb-design-comment wb-create-table-name">
        <span>{{ t('createTable.name') }}</span>
        <input ref="tableNameInput" v-model="draft.tableName" name="newTableName" :disabled="saving" maxlength="64" :placeholder="t('createTable.namePlaceholder')" :aria-label="t('createTable.name')" spellcheck="false" />
      </label>
      <label class="wb-design-comment">
        <span>{{ t('m_a00092e726d4') }}</span>
        <textarea v-model="draft.tableComment" name="tableComment" rows="2" :placeholder="t('m_687694cbea0f')"></textarea>
      </label>

      <div class="wb-design-subtabs" role="tablist" :aria-label="t('design.tabs.aria')">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'columns'"
          :class="{ 'is-active': activeTab === 'columns' }"
          @click="activeTab = 'columns'"
        >{{ t('design.tabs.columns') }}</button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'indexes'"
          :class="{ 'is-active': activeTab === 'indexes' }"
          @click="activeTab = 'indexes'"
        >
          {{ t('design.tabs.indexes') }}
          <span v-if="draft.indexes.length" class="wb-design-subtab-count">{{ draft.indexes.length }}</span>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'options'"
          :class="{ 'is-active': activeTab === 'options' }"
          @click="activeTab = 'options'"
        >{{ t('design.tabs.options') }}</button>
      </div>

      <div v-show="activeTab === 'columns'" class="wb-design-grid-wrap">
        <table class="wb-design-grid">
          <thead>
            <tr>
              <th
                class="wb-design-select-col"
                :style="{ width: colWidths.select + 'px', minWidth: colWidths.select + 'px' }"
                :title="t('m_12814fa9f970')"
              >#</th>
              <th
                v-for="col in colDefs"
                :key="col.key"
                :style="{ width: colWidths[col.key] + 'px', minWidth: colWidths[col.key] + 'px', position: 'relative' }"
              >
                {{ t(col.labelKey) }}
                <span
                  class="wb-design-col-resize"
                  :class="{ 'is-resizing': resizingCol === col.key }"
                  @mousedown.stop="startResize(col.key, $event)"
                />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(column, index) in draft.columns"
              :key="column.id || column.originalName || index"
              :class="{
                'is-dragging': dragIndex === index,
                'is-drag-over': dragOverIndex === index && dragIndex !== index,
                'is-selected': isSelected(index),
              }"
              @mousedown="onRowPointerDown(index, $event)"
              @focusin="onFieldFocus(index)"
              @dragover="onDragOver(index, $event)"
              @dragleave="onDragLeave"
              @drop="onDrop(index)"
            >
              <td
                class="wb-design-select-cell"
                :style="{ width: colWidths.select + 'px' }"
                :title="t('m_12814fa9f970')"
                @mousedown.prevent="selectRow(index, $event)"
                @click.prevent="selectRow(index, $event)"
              >{{ index + 1 }}</td>
              <!-- 字段名 -->
              <td :style="{ width: colWidths.name + 'px' }">
                <div class="wb-design-name-cell">
                  <span
                    class="wb-design-drag-handle"
                    draggable="true"
                    :title="t('m_cd94bbd84d72')"
                    :aria-label="t('m_bde502acb519')"
                    @dragstart.stop="onDragStart(index, $event)"
                    @dragend="onDragEnd"
                  >⋮⋮</span>
                  <input v-model="column.name" :aria-label="t('m_2b018f9b1038')" />
                </div>
                <small v-if="validationErrors.columns?.[index]?.name">{{ validationErrors.columns[index].name }}</small>
              </td>

              <!-- 主键 -->
              <td class="wb-design-primary-key-cell" :style="{ width: colWidths.primaryKey + 'px' }">
                <button
                  type="button"
                  class="wb-design-primary-key-toggle"
                  :class="{ 'is-primary': column.primaryKey }"
                  :aria-label="primaryKeyLabel(column)"
                  :aria-pressed="column.primaryKey"
                  :title="primaryKeyTitle(column)"
                  @click="togglePrimaryKey(column)"
                >
                  <KeyRound v-if="column.primaryKey" :size="15" :stroke-width="2.2" aria-hidden="true" />
                  <Plus v-else class="wb-design-primary-key-add" :size="14" :stroke-width="1.7" aria-hidden="true" />
                  <span v-if="column.primaryKey" class="wb-design-primary-key-number" aria-hidden="true">{{ column.primaryKeyOrdinal }}</span>
                </button>
                <small v-if="validationErrors.columns?.[index]?.primaryKey">{{ validationErrors.columns[index].primaryKey }}</small>
              </td>

              <!-- 类型 -->
              <td :style="{ width: colWidths.type + 'px' }">
                <select
                  :value="column.type"
                  :aria-label="t('m_9eb4ed77634f')"
                  @change="onTypeChange(column, $event.target.value)"
                >
                  <option value="">{{ t('m_da590a8fe3ce') }}</option>
                  <option v-for="t in MYSQL_COMMON_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
                </select>
                <small v-if="validationErrors.columns?.[index]?.type">{{ validationErrors.columns[index].type }}</small>
              </td>

              <!-- 长度 -->
              <td :style="{ width: colWidths.length + 'px' }">
                <input v-model="column.length" :aria-label="t('m_a75e99080569')" inputmode="numeric" />
                <small v-if="validationErrors.columns?.[index]?.length">{{ validationErrors.columns[index].length }}</small>
              </td>

              <!-- 小数位 -->
              <td :style="{ width: colWidths.scale + 'px' }">
                <input v-model="column.scale" :disabled="!typeSupportsScale(column.type)" :aria-label="t('m_571bf00dfd42')" inputmode="numeric" />
                <small v-if="validationErrors.columns?.[index]?.scale">{{ validationErrors.columns[index].scale }}</small>
              </td>

              <!-- 无符号 -->
              <td class="wb-design-check-cell" :style="{ width: colWidths.unsigned + 'px' }">
                <input
                  v-model="column.unsigned"
                  type="checkbox"
                  :disabled="!typeSupportsUnsigned(column.type)"
                  :aria-label="t('design.column.unsigned')"
                  :title="t('design.column.unsignedHint')"
                />
                <small v-if="validationErrors.columns?.[index]?.unsigned">{{ validationErrors.columns[index].unsigned }}</small>
              </td>

              <!-- 自增 -->
              <td class="wb-design-check-cell" :style="{ width: colWidths.autoIncrement + 'px' }">
                <input
                  :checked="column.autoIncrement"
                  type="checkbox"
                  :disabled="!typeSupportsAutoIncrement(column.type)"
                  :aria-label="t('design.column.autoIncrement')"
                  :title="t('design.column.autoIncrementHint')"
                  @change="toggleAutoIncrement(column)"
                />
                <small v-if="validationErrors.columns?.[index]?.autoIncrement">{{ validationErrors.columns[index].autoIncrement }}</small>
              </td>

              <!-- 允许 NULL -->
              <td class="wb-design-check-cell" :style="{ width: colWidths.nullable + 'px' }">
                <input v-model="column.nullable" type="checkbox" :disabled="column.primaryKey || column.autoIncrement" :aria-label="t('m_0693812e331c')" />
                <small v-if="validationErrors.columns?.[index]?.nullable">{{ validationErrors.columns[index].nullable }}</small>
              </td>

              <!-- 默认值模式 -->
              <td :style="{ width: colWidths.defaultMode + 'px' }">
                <select v-model="column.defaultMode" :disabled="column.autoIncrement" :aria-label="t('design.column.defaultMode')">
                  <option value="none">{{ t('m_484d55613910') }}</option>
                  <option value="null">NULL</option>
                  <option value="value">{{ t('m_a92a585d1fbf') }}</option>
                  <option value="expression">{{ t('m_ea2fc789884b') }}</option>
                </select>
                <small v-if="validationErrors.columns?.[index]?.defaultMode">{{ validationErrors.columns[index].defaultMode }}</small>
              </td>

              <!-- 默认值 -->
              <td :style="{ width: colWidths.defaultValue + 'px' }">
                <input v-model="column.defaultValue" :disabled="column.autoIncrement || column.defaultMode === 'none' || column.defaultMode === 'null'" :aria-label="t('m_306da767a461')" />
                <small v-if="validationErrors.columns?.[index]?.defaultValue">{{ validationErrors.columns[index].defaultValue }}</small>
              </td>

              <!-- 备注 -->
              <td class="wb-design-comment-cell" :style="{ width: colWidths.comment + 'px' }">
                <div class="wb-design-comment-input">
                  <input v-model="column.comment" :aria-label="t('m_39230fff0eb1')" />
                  <button
                    type="button"
                    class="wb-design-comment-expand"
                    :title="t('m_df99e81b3dea')"
                    :aria-label="t('m_df99e81b3dea')"
                    @click="openCommentDialog(index)"
                  > {{ t('m_051836569928') }} </button>
                </div>
                <small v-if="validationErrors.columns?.[index]?.comment">{{ validationErrors.columns[index].comment }}</small>
              </td>

              <!-- 操作 -->
              <td class="wb-design-actions-cell" :style="{ width: colWidths.actions + 'px' }">
                <button
                  type="button"
                  class="wb-design-row-remove"
                  :disabled="draft.columns.length <= 1"
                  :title="draft.columns.length <= 1 ? t('m_8367b93e3ec1') : (isNewColumn(column) ? t('m_1987ca219327') : t('m_d88366de4c06'))"
                  :aria-label="t('m_32025c825b14')"
                  @click="removeColumn(index)"
                ><Trash2 :size="14" /></button>
              </td>
            </tr>
            <tr class="wb-design-add-row">
              <td :colspan="colDefs.length + 1">
                <button
                  type="button"
                  class="wb-design-add-column"
                  :disabled="loading || previewing || saving"
                  :title="t('m_628de21eae14')"
                  :aria-label="t('m_628de21eae14')"
                  @click="addColumn()"
                >
                  <Plus :size="16" />
                  <span>{{ t('m_628de21eae14') }}</span>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 索引页签 -->
      <div v-show="activeTab === 'indexes'" class="wb-design-grid-wrap">
        <table class="wb-design-grid wb-design-index-grid">
          <thead>
            <tr>
              <th class="wb-design-select-col">#</th>
              <th>{{ t('design.indexes.name') }}</th>
              <th>{{ t('design.indexes.type') }}</th>
              <th>{{ t('design.indexes.columns') }}</th>
              <th>{{ t('design.indexes.comment') }}</th>
              <th>{{ t('design.column.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(indexItem, idx) in draft.indexes" :key="indexItem.id || indexItem.originalName || idx">
              <td class="wb-design-select-cell">{{ idx + 1 }}</td>
              <td>
                <input v-model="indexItem.name" :aria-label="t('design.indexes.name')" spellcheck="false" />
                <small v-if="validationErrors.indexes?.[idx]?.name">{{ validationErrors.indexes[idx].name }}</small>
              </td>
              <td>
                <WorkbenchSelect
                  v-model="indexItem.indexType"
                  :options="INDEX_TYPES"
                  :aria-label="t('design.indexes.type')"
                  :searchable="false"
                  :monospace="true"
                />
              </td>
              <td>
                <div class="wb-design-index-columns">
                  <span v-for="(colName, colIdx) in indexItem.columns" :key="colName" class="wb-design-index-chip">
                    <span>{{ colName }}</span>
                    <button
                      v-if="colIdx > 0"
                      type="button"
                      class="wb-design-index-chip-btn"
                      :title="t('design.indexes.moveUp')"
                      @click="moveIndexColumn(indexItem, colIdx, -1)"
                    ><ArrowUp :size="11" /></button>
                    <button
                      v-if="colIdx < indexItem.columns.length - 1"
                      type="button"
                      class="wb-design-index-chip-btn"
                      :title="t('design.indexes.moveDown')"
                      @click="moveIndexColumn(indexItem, colIdx, 1)"
                    ><ArrowDown :size="11" /></button>
                    <button
                      type="button"
                      class="wb-design-index-chip-btn"
                      :title="t('design.indexes.removeColumn')"
                      @click="removeIndexColumn(indexItem, colIdx)"
                    >×</button>
                  </span>
                  <WorkbenchSelect
                    v-if="unusedColumnsForIndex(indexItem).length"
                    class="wb-design-index-add-col"
                    :model-value="''"
                    :options="unusedColumnsForIndex(indexItem)"
                    :placeholder="t('design.indexes.addColumn')"
                    :aria-label="t('design.indexes.addColumn')"
                    :searchable="false"
                    :monospace="true"
                    @change="(val) => onAppendIndexColumn(indexItem, val)"
                  />
                </div>
                <small v-if="validationErrors.indexes?.[idx]?.columns">{{ validationErrors.indexes[idx].columns }}</small>
              </td>
              <td>
                <input v-model="indexItem.comment" :aria-label="t('design.indexes.comment')" />
              </td>
              <td class="wb-design-actions-cell">
                <button
                  type="button"
                  class="wb-design-row-remove"
                  :title="t('design.indexes.remove')"
                  :aria-label="t('design.indexes.remove')"
                  @click="removeIndex(idx)"
                ><Trash2 :size="14" /></button>
              </td>
            </tr>
            <tr class="wb-design-add-row">
              <td colspan="6">
                <button
                  type="button"
                  class="wb-design-add-column"
                  :disabled="loading || previewing || saving"
                  @click="addIndex()"
                >
                  <Plus :size="16" />
                  <span>{{ t('design.indexes.add') }}</span>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 表选项页签 -->
      <div v-show="activeTab === 'options'" class="wb-design-options-panel">
        <div class="wb-dialog-field">
          <span>{{ t('design.options.engine') }}</span>
          <WorkbenchSelect
            v-model="draft.engine"
            :options="[{ value: '', label: t('design.options.serverDefault') }, ...MYSQL_ENGINES]"
            :aria-label="t('design.options.engine')"
            :searchable="false"
            :monospace="true"
          />
        </div>
        <div class="wb-dialog-field">
          <span>{{ t('design.options.charset') }}</span>
          <WorkbenchSelect
            :model-value="draft.charset"
            :options="[{ value: '', label: t('design.options.serverDefault') }, ...charsetOptions.map((item) => item.charset)]"
            :aria-label="t('design.options.charset')"
            :searchable="true"
            :monospace="true"
            @change="onCharsetChange"
          />
        </div>
        <div class="wb-dialog-field">
          <span>{{ t('design.options.collation') }}</span>
          <WorkbenchSelect
            v-model="draft.collation"
            :options="[{ value: '', label: t('design.options.charsetDefault') }, ...availableCollations]"
            :aria-label="t('design.options.collation')"
            :disabled="!draft.charset"
            :searchable="true"
            :monospace="true"
          />
        </div>
      </div>
    </div>

    <!-- 修改预览 Dialog -->
    <div v-if="previewOpen" class="wb-design-preview">
      <section ref="previewDialogRef" class="wb-design-preview-card" role="dialog" aria-modal="true" :aria-label="t('m_e95dd315e43a')" tabindex="-1">
        <header class="wb-design-preview-header">
          <strong>{{ t('m_e95dd315e43a') }}</strong>
          <button type="button" :disabled="saving" @click="closePreviewDialog">{{ t('m_484533ab89b8') }}</button>
        </header>

        <!-- 冲突提示（阻止保存） -->
        <div v-if="preview.conflicts?.length" class="wb-design-conflicts wb-design-conflicts-critical" role="alert">
          <div class="wb-design-conflicts-title">{{ t('m_10493d06b90f') }} {{ preview.conflicts.length }} {{ t('m_1b9ce5b85eb9') }}</div>
          <div class="wb-design-conflicts-subtitle">{{ t('m_ae9f3f2f2301') }}</div>
          <ul>
            <li v-for="(conflict, idx) in preview.conflicts" :key="'conflict-' + idx">{{ idx + 1 }}. {{ conflict }}</li>
          </ul>
        </div>

        <!-- 警告 -->
        <ul v-if="preview.warnings?.length" class="wb-design-warnings">
          <li v-for="warning in preview.warnings" :key="warning">{{ warning }}</li>
        </ul>

        <!-- 中文修改说明 -->
        <div v-if="preview.humanDescriptions?.length" class="wb-design-human-list">
          <div class="wb-design-human-title">{{ t('m_f8c752ebfdcd') }}</div>
          <ul>
            <li v-for="(desc, idx) in preview.humanDescriptions" :key="'desc-' + idx">{{ desc }}</li>
          </ul>
        </div>
        <div v-else-if="!preview.conflicts?.length" class="wb-design-no-changes"> {{ t('m_170b2e1477c3') }} </div>

        <!-- 原始 SQL（可折叠，供高级用户参考） -->
        <details class="wb-design-sql-details">
          <summary>{{ t('m_605bf486a7ae') }}</summary>
          <pre class="wb-design-sql"><code>{{ (preview.statements || []).join(";\n") }}</code></pre>
        </details>

        <footer class="wb-design-preview-actions">
          <button type="button" @click="exportErrors">{{ t('m_15730403e341') }}</button>
          <button type="button" :disabled="saving" @click="closePreviewDialog">{{ t('m_2cd0f3be8738') }}</button>
          <button v-if="preview.conflicts?.length" type="button" class="wb-design-danger" :disabled="saving || Boolean(preview.conflicts?.length)" @click="handleConfirmApply">{{ t('m_0656d19dd4a5') }}</button>
          <button v-else-if="creating" type="button" class="wb-design-primary" :disabled="saving" @click="handleConfirmApply">{{ t('createTable.confirm') }}</button>
          <button v-else type="button" class="wb-design-danger" :disabled="saving" @click="handleConfirmApply">{{ t('m_881f5971987d') }}</button>
        </footer>
      </section>
    </div>

    <!-- Comment Dialog -->
    <div v-if="commentDialog.open" class="wb-design-comment-dialog-overlay">
      <div ref="commentDialogRef" class="wb-design-comment-dialog" role="dialog" aria-modal="true" :aria-label="t('m_2d22af42a79f')" tabindex="-1">
        <header class="wb-design-comment-dialog-header">
          <span>{{ t('m_df99e81b3dea') }}</span>
          <button type="button" class="wb-dialog-close" @click="closeCommentDialog(false)">&times;</button>
        </header>
        <div class="wb-design-comment-dialog-body">
          <div class="wb-design-comment-dialog-edit">
            <label class="wb-design-comment-dialog-label">{{ t('m_ea9008f9e495') }}</label>
            <textarea v-model="commentDialog.value" :placeholder="t('m_5d8a2f9fc808')"></textarea>
          </div>
          <div class="wb-design-comment-dialog-preview">
            <label class="wb-design-comment-dialog-label">{{ t('m_a76fdaad7519') }}</label>
            <div
              class="wb-design-comment-dialog-preview-content"
              v-html="commentPreviewHtml"
            />
          </div>
        </div>
        <footer class="wb-design-comment-dialog-actions">
          <button type="button" @click="closeCommentDialog(false)">{{ t('m_2cd0f3be8738') }}</button>
          <button type="button" class="wb-design-primary" @click="closeCommentDialog(true)">{{ t('m_4f8b0ab088ec') }}</button>
        </footer>
      </div>
    </div>
  </section>
</template>
