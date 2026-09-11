<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { KeyRound, Plus, Trash2 } from "lucide-vue-next";

import { useTableDesign } from "../composables/useTableDesign.js";
import { useEscClose } from "../composables/useEscClose.js";
import { MYSQL_COMMON_TYPES, getTypeDefaultLength } from "../utils/tableDesign.js";
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
  isNewColumn,
} = useTableDesign(props.invokeWorkbench, computed(() => props.source), {
  onApplied: (event) => emit("applied", event),
});

const sourceTitle = computed(() => {
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
  try {
    const result = await applyDesign();
    if (!result) return;
    previewOpen.value = false;
    showSuccess("表设计保存成功");
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
  if (commentDialog.open || previewOpen.value) return false;
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
    // Leave native paste to inputs so ordinary text still goes into the field.
    // Field payloads are intercepted by the capture-phase paste listener.
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

onMounted(() => refreshDesign({ notify: false }));
watch(sourceKey, () => {
  clearRowSelection();
  refreshDesign({ notify: false });
});

/* ---------- Column resizing ---------- */
const defaultColWidths = {
  select: 36,
  name: 140,
  primaryKey: 82,
  type: 130,
  length: 80,
  scale: 70,
  nullable: 80,
  defaultMode: 100,
  defaultValue: 120,
  comment: 160,
  actions: 64,
};

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
  const newWidth = Math.max(50, resizeStartWidth.value + delta);
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

  // Headers
  html = html.replace(/^###### (.*$)/gim, "<h6>$1</h6>");
  html = html.replace(/^##### (.*$)/gim, "<h5>$1</h5>");
  html = html.replace(/^#### (.*$)/gim, "<h4>$1</h4>");
  html = html.replace(/^### (.*$)/gim, "<h3>$1</h3>");
  html = html.replace(/^## (.*$)/gim, "<h2>$1</h2>");
  html = html.replace(/^# (.*$)/gim, "<h1>$1</h1>");

  // Bold & Italic
  html = html.replace(/\*\*\*(.*?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
  html = html.replace(/___(.*?)___/g, "<strong><em>$1</em></strong>");
  html = html.replace(/__(.*?)__/g, "<strong>$1</strong>");
  html = html.replace(/_(.*?)_/g, "<em>$1</em>");

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Code blocks
  html = html.replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%;border-radius:4px;" />');

  // Horizontal rule
  html = html.replace(/^---$/gim, "<hr />");
  html = html.replace(/^\*\*\*$/gim, "<hr />");

  // Blockquote
  html = html.replace(/^&gt; (.*$)/gim, "<blockquote>$1</blockquote>");

  // Unordered list
  html = html.replace(/^\- (.*$)/gim, "<li>$1</li>");
  html = html.replace(/^(<li>.*<\/li>\n?)+/gm, (match) => `<ul>${match}</ul>`);

  // Ordered list
  html = html.replace(/^\d+\.\s+(.*$)/gim, "<li>$1</li>");

  // Paragraphs (wrap lines that are not already wrapped)
  html = html.replace(/^(?!<[hou]|<li|<block|<hr|<pre|<img)(.+)$/gim, "<p>$1</p>");

  // Clean up empty paragraphs
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
  { key: "name", label: "字段名" },
  { key: "primaryKey", label: "主键顺序" },
  { key: "type", label: "类型" },
  { key: "length", label: "长度" },
  { key: "scale", label: "小数位" },
  { key: "nullable", label: "允许 NULL" },
  { key: "defaultMode", label: "默认值模式" },
  { key: "defaultValue", label: "默认值" },
  { key: "comment", label: "备注" },
  { key: "actions", label: "操作" },
];
</script>

<template>
  <section
    ref="editorRef"
    class="wb-design-editor"
    aria-label="表设计编辑器"
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
        <strong>表设计</strong>
        <span :title="sourceTitle">{{ sourceTitle }}</span>
        <em v-if="dirty" class="wb-design-dirty">未保存</em>
      </div>
      <div class="wb-design-actions">
        <button type="button" :disabled="loading || previewing || saving" @click="refreshDesign">刷新</button>
        <button type="button" :disabled="loading || previewing || saving || !dirty" @click="resetDraft">重置</button>
        <button type="button" :disabled="loading || saving" @click="handlePreview">{{ previewing ? "取消字段检查" : "SQL 预览" }}</button>
        <button type="button" class="wb-design-primary" :disabled="loading || previewing || saving || !dirty" @click="handleSave">{{ previewing ? "正在检查字段数据…" : "保存" }}</button>
      </div>
    </header>

    <div v-if="loading" class="wb-design-state">正在加载表设计…</div>
    <div v-else class="wb-design-body">
      <p v-if="previewing" class="wb-design-state" role="status" aria-live="polite">数据库正在严格模式下检查现有字段值；大表可能需要一些时间，可随时取消。</p>
      <p v-if="error" class="wb-design-error" role="alert">{{ error }}</p>
      <div v-if="previewHasConflicts" class="wb-design-conflict-banner" role="alert">
        <strong>发现无法转换的字段值</strong>
        <span>请先修正提示中的现有数据，再重新预览并保存字段类型。</span>
      </div>
      <div v-if="hasValidationMessages" class="wb-design-validation" role="alert">
        <strong>请先修正以下问题</strong>
        <span v-for="message in validationErrors.messages" :key="message">{{ message }}</span>
      </div>

      <label class="wb-design-comment">
        <span>表备注</span>
        <textarea v-model="draft.tableComment" name="tableComment" rows="2" placeholder="输入表备注"></textarea>
      </label>

      <div class="wb-design-grid-wrap">
        <table class="wb-design-grid">
          <thead>
            <tr>
              <th
                class="wb-design-select-col"
                :style="{ width: colWidths.select + 'px', minWidth: colWidths.select + 'px' }"
                title="点击选中字段，Shift 连选，Ctrl 多选"
              >#</th>
              <th
                v-for="col in colDefs"
                :key="col.key"
                :style="{ width: colWidths[col.key] + 'px', minWidth: colWidths[col.key] + 'px', position: 'relative' }"
              >
                {{ col.label }}
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
                title="点击选中字段，Shift 连选，Ctrl 多选"
                @mousedown.prevent="selectRow(index, $event)"
                @click.prevent="selectRow(index, $event)"
              >{{ index + 1 }}</td>
              <!-- 字段名 -->
              <td :style="{ width: colWidths.name + 'px' }">
                <div class="wb-design-name-cell">
                  <span
                    class="wb-design-drag-handle"
                    draggable="true"
                    title="按住拖拽调整字段顺序"
                    aria-label="拖拽调整字段顺序"
                    @dragstart.stop="onDragStart(index, $event)"
                    @dragend="onDragEnd"
                  >⋮⋮</span>
                  <input v-model="column.name" aria-label="字段名" />
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
                  aria-label="字段类型"
                  @change="onTypeChange(column, $event.target.value)"
                >
                  <option value="">请选择</option>
                  <option v-for="t in MYSQL_COMMON_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
                </select>
                <small v-if="validationErrors.columns?.[index]?.type">{{ validationErrors.columns[index].type }}</small>
              </td>

              <!-- 长度 -->
              <td :style="{ width: colWidths.length + 'px' }">
                <input v-model="column.length" aria-label="字段长度" inputmode="numeric" />
                <small v-if="validationErrors.columns?.[index]?.length">{{ validationErrors.columns[index].length }}</small>
              </td>

              <!-- 小数位 -->
              <td :style="{ width: colWidths.scale + 'px' }">
                <input v-model="column.scale" aria-label="小数位" inputmode="numeric" />
                <small v-if="validationErrors.columns?.[index]?.scale">{{ validationErrors.columns[index].scale }}</small>
              </td>

              <!-- 允许 NULL -->
              <td class="wb-design-check-cell" :style="{ width: colWidths.nullable + 'px' }">
                <input v-model="column.nullable" type="checkbox" :disabled="column.primaryKey" aria-label="允许 NULL" />
                <small v-if="validationErrors.columns?.[index]?.nullable">{{ validationErrors.columns[index].nullable }}</small>
              </td>

              <!-- 默认值模式 -->
              <td :style="{ width: colWidths.defaultMode + 'px' }">
                <select v-model="column.defaultMode" aria-label="defaultMode">
                  <option value="none">无</option>
                  <option value="null">NULL</option>
                  <option value="value">固定值</option>
                  <option value="expression">表达式</option>
                </select>
                <small v-if="validationErrors.columns?.[index]?.defaultMode">{{ validationErrors.columns[index].defaultMode }}</small>
              </td>

              <!-- 默认值 -->
              <td :style="{ width: colWidths.defaultValue + 'px' }">
                <input v-model="column.defaultValue" :disabled="column.defaultMode === 'none' || column.defaultMode === 'null'" aria-label="默认值" />
                <small v-if="validationErrors.columns?.[index]?.defaultValue">{{ validationErrors.columns[index].defaultValue }}</small>
              </td>

              <!-- 备注 -->
              <td class="wb-design-comment-cell" :style="{ width: colWidths.comment + 'px' }">
                <div class="wb-design-comment-input">
                  <input v-model="column.comment" aria-label="字段备注" />
                  <button
                    type="button"
                    class="wb-design-comment-expand"
                    title="编辑字段备注"
                    aria-label="编辑字段备注"
                    @click="openCommentDialog(index)"
                  >
                    编辑
                  </button>
                </div>
                <small v-if="validationErrors.columns?.[index]?.comment">{{ validationErrors.columns[index].comment }}</small>
              </td>

              <!-- 操作 -->
              <td class="wb-design-actions-cell" :style="{ width: colWidths.actions + 'px' }">
                <button
                  type="button"
                  class="wb-design-row-remove"
                  :disabled="draft.columns.length <= 1"
                  :title="draft.columns.length <= 1 ? '表中至少需要保留一个字段' : (isNewColumn(column) ? '移除新增字段' : '删除字段（保存时生效）')"
                  aria-label="删除字段"
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
                  title="新增字段"
                  aria-label="新增字段"
                  @click="addColumn()"
                >
                  <Plus :size="16" />
                  <span>新增字段</span>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 修改预览 Dialog -->
    <div v-if="previewOpen" class="wb-design-preview">
      <section ref="previewDialogRef" class="wb-design-preview-card" role="dialog" aria-modal="true" aria-label="修改预览" tabindex="-1">
        <header class="wb-design-preview-header">
          <strong>修改预览</strong>
          <button type="button" :disabled="saving" @click="closePreviewDialog">✕ 关闭</button>
        </header>

        <!-- 冲突提示（阻止保存） -->
        <div v-if="preview.conflicts?.length" class="wb-design-conflicts wb-design-conflicts-critical" role="alert">
          <div class="wb-design-conflicts-title">发现 {{ preview.conflicts.length }} 个字段存在无法转换的值</div>
          <div class="wb-design-conflicts-subtitle">请先修正这些现有数据，再重新预览并保存：</div>
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
          <div class="wb-design-human-title">将要执行的修改：</div>
          <ul>
            <li v-for="(desc, idx) in preview.humanDescriptions" :key="'desc-' + idx">{{ desc }}</li>
          </ul>
        </div>
        <div v-else-if="!preview.conflicts?.length" class="wb-design-no-changes">
          没有检测到修改。
        </div>

        <!-- 原始 SQL（可折叠，供高级用户参考） -->
        <details class="wb-design-sql-details">
          <summary>查看原始 SQL 语句</summary>
          <pre class="wb-design-sql"><code>{{ (preview.statements || []).join(";\n") }}</code></pre>
        </details>

        <footer class="wb-design-preview-actions">
          <button type="button" @click="exportErrors">导出报错信息</button>
          <button type="button" :disabled="saving" @click="closePreviewDialog">取消</button>
          <button v-if="preview.conflicts?.length" type="button" class="wb-design-danger" :disabled="saving || Boolean(preview.conflicts?.length)" @click="handleConfirmApply">数据不兼容，无法执行</button>
          <button v-else type="button" class="wb-design-danger" :disabled="saving" @click="handleConfirmApply">执行 ALTER TABLE</button>
        </footer>
      </section>
    </div>

    <!-- Comment Dialog -->
    <div v-if="commentDialog.open" class="wb-design-comment-dialog-overlay">
      <div ref="commentDialogRef" class="wb-design-comment-dialog" role="dialog" aria-modal="true" aria-label="编辑备注" tabindex="-1">
        <header class="wb-design-comment-dialog-header">
          <span>编辑字段备注</span>
          <button type="button" class="wb-dialog-close" @click="closeCommentDialog(false)">&times;</button>
        </header>
        <div class="wb-design-comment-dialog-body">
          <div class="wb-design-comment-dialog-edit">
            <label class="wb-design-comment-dialog-label">编辑 (支持 Markdown)</label>
            <textarea v-model="commentDialog.value" placeholder="输入备注内容，支持 Markdown 格式…"></textarea>
          </div>
          <div class="wb-design-comment-dialog-preview">
            <label class="wb-design-comment-dialog-label">实时预览</label>
            <div
              class="wb-design-comment-dialog-preview-content"
              v-html="commentPreviewHtml"
            />
          </div>
        </div>
        <footer class="wb-design-comment-dialog-actions">
          <button type="button" @click="closeCommentDialog(false)">取消</button>
          <button type="button" class="wb-design-primary" @click="closeCommentDialog(true)">保存备注</button>
        </footer>
      </div>
    </div>
  </section>
</template>
