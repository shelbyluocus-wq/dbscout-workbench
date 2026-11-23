<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Check, CircleAlert, Copy, ListOrdered, Plus, Sparkles, Tag, Trash2, X } from "lucide-vue-next";
import { useEscClose } from "../composables/useEscClose.js";
import { formatShortcutForPlatform } from "../utils/desktopPlatform.js";
import { isImeKeyEvent } from "../utils/imeInput.js";
import { columnName as normalizeColumnName, normalizeTableComment, normalizeTableName } from "../utils/normalize.js";
import {
  MAX_COLUMN_COMMENT_LENGTH,
  composeCommentWithDirective,
  formatAgentMeaningClipboard,
  formatCommentDirective,
  parseCommentDirective,
  parseListExtractor,
  resolveCellEnumPreview,
  resolveCellSlotPreview,
  stripCommentDirectives,
  suggestEnumEntriesFromComment,
  suggestSlotLabelsFromComment,
} from "../utils/commentDirectives.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  kind: { type: String, default: "column" },
  name: { type: String, default: "" },
  tableName: { type: String, default: "" },
  database: { type: String, default: "" },
  value: { type: String, default: "" },
  sampleValue: { type: String, default: "" },
  readOnly: { type: Boolean, default: false },
  tables: { type: Array, default: () => [] },
  loadTableColumns: { type: Function, default: null },
  saving: { type: Boolean, default: false },
  error: { type: String, default: "" },
});

const emit = defineEmits(["close", "save"]);

const IDENT_RE = /^[A-Za-z0-9_]+$/;
const MODES = Object.freeze(["none", "enum", "slots", "value", "list", "noRelation"]);

const uid = Math.random().toString(36).slice(2, 9);
const tableListId = `wb-comment-tables-${uid}`;
const columnListId = `wb-comment-columns-${uid}`;

const draft = ref("");
const mode = ref("none");
const enumEntries = ref([]);
const slotLabels = ref([]);
const targetTable = ref("");
const targetColumn = ref("");
const listFormat = ref("auto");
const listExtractorInput = ref("");
const loadedColumnsMap = ref({});
const copiedKind = ref("");
let copiedTimer = 0;
let columnLoadToken = 0;

const dialogRef = ref(null);
const textareaRef = ref(null);

const isColumnKind = computed(() => props.kind !== "table");
const subject = computed(() => {
  const table = props.kind === "table";
  const label = t(table ? "m_a00092e726d4" : "m_39230fff0eb1");
  const name = table ? props.name : [props.tableName, props.name].filter(Boolean).join(".");
  return name ? `${label} · ${name}` : label;
});
const saveShortcut = formatShortcutForPlatform("Ctrl+Enter");

const normalizedTables = computed(() => (
  (Array.isArray(props.tables) ? props.tables : [])
    .map((table) => ({
      name: normalizeTableName(table),
      comment: normalizeTableComment(table),
      columns: Array.isArray(table?.columns) ? table.columns : [],
    }))
    .filter((table) => table.name)
));

const matchedTargetTable = computed(() => {
  const wanted = targetTable.value.trim().toLowerCase();
  if (!wanted) return null;
  return normalizedTables.value.find((table) => table.name.toLowerCase() === wanted) || null;
});

const targetTableColumns = computed(() => {
  const wanted = targetTable.value.trim().toLowerCase();
  if (!wanted) return [];
  const cached = loadedColumnsMap.value[wanted];
  const rawCols = Array.isArray(cached) && cached.length
    ? cached
    : (matchedTargetTable.value?.columns || []);
  return rawCols
    .map((col) => ({
      name: normalizeColumnName(col),
      comment: String(col?.column_comment || col?.columnComment || "").trim(),
      isPrimaryKey: Boolean(col?.is_primary_key || col?.isPrimaryKey),
    }))
    .filter((col) => col.name);
});

const suggestedEnumEntries = computed(() => (
  isColumnKind.value ? suggestEnumEntriesFromComment(draft.value) : []
));
const suggestedSlotLabels = computed(() => (
  isColumnKind.value ? suggestSlotLabelsFromComment(draft.value) : []
));

const effectiveListExtractor = computed(() => {
  if (mode.value !== "list") return "";
  if (listFormat.value === "auto") return "";
  if (listFormat.value === "json") return "json";
  if (listFormat.value === "comma") return ",";
  if (listFormat.value === "pipe") return "|";
  return listExtractorInput.value.trim();
});

const directiveSpec = computed(() => {
  if (!isColumnKind.value || mode.value === "none") return { kind: "none" };
  if (mode.value === "noRelation") return { kind: "noRelation" };
  if (mode.value === "enum") {
    return {
      kind: "enum",
      entries: enumEntries.value
        .map((entry) => ({ key: String(entry.key ?? "").trim(), label: String(entry.label ?? "").trim() }))
        .filter((entry) => entry.key && entry.label),
    };
  }
  if (mode.value === "slots") {
    return {
      kind: "slots",
      slots: slotLabels.value.map((item) => String(item ?? "").trim()).filter(Boolean),
    };
  }
  return {
    kind: mode.value,
    targetTable: targetTable.value.trim(),
    targetColumn: targetColumn.value.trim(),
    extractor: effectiveListExtractor.value,
  };
});

const directiveTag = computed(() => formatCommentDirective(directiveSpec.value));

const finalComment = computed(() => {
  if (!isColumnKind.value) return draft.value;
  if (mode.value === "none") return stripCommentDirectives(draft.value);
  return composeCommentWithDirective(draft.value, directiveSpec.value);
});

const validationError = computed(() => {
  if (!isColumnKind.value) return "";
  if (mode.value === "enum") {
    if (!directiveSpec.value.entries.length) return t("commentEdit.enumEmptyError");
  } else if (mode.value === "slots") {
    if (!directiveSpec.value.slots.length) return t("commentEdit.slotsEmptyError");
  } else if (mode.value === "value" || mode.value === "list") {
    const tbl = targetTable.value.trim();
    const col = targetColumn.value.trim();
    if (!tbl || !IDENT_RE.test(tbl)) return t("commentEdit.targetTableError");
    if (col && !IDENT_RE.test(col)) return t("commentEdit.targetColumnError");
    if (mode.value === "list" && (listFormat.value === "member" || listFormat.value === "path")) {
      const ext = listExtractorInput.value.trim();
      if (!ext || !parseListExtractor(ext)) return t("commentEdit.listExtractorError");
    }
  }
  if (finalComment.value.length > MAX_COLUMN_COMMENT_LENGTH) {
    return t("commentEdit.lengthWarning", {
      length: finalComment.value.length,
      max: MAX_COLUMN_COMMENT_LENGTH,
    });
  }
  return "";
});

const sampleEnumPreview = computed(() => {
  if (!isColumnKind.value || mode.value !== "enum" || !directiveTag.value) return [];
  const sample = String(props.sampleValue ?? "").trim();
  if (!sample) return [];
  return resolveCellEnumPreview(sample, directiveTag.value);
});

const sampleSlotPreview = computed(() => {
  if (!isColumnKind.value || mode.value !== "slots" || !directiveTag.value) return [];
  const sample = String(props.sampleValue ?? "").trim();
  if (!sample) return [];
  return resolveCellSlotPreview(sample, directiveTag.value);
});

useEscClose(
  () => props.open,
  () => {
    if (!props.saving) emit("close");
  },
  () => props.saving,
  { dialogRef },
);

function initFromValue(rawValue) {
  copiedKind.value = "";
  const text = String(rawValue || "");
  if (!isColumnKind.value) {
    draft.value = text;
    mode.value = "none";
    return;
  }
  const parsed = parseCommentDirective(text);
  draft.value = parsed.hasDirective ? stripCommentDirectives(text) : text;
  enumEntries.value = [];
  slotLabels.value = [];
  targetTable.value = "";
  targetColumn.value = "";
  listFormat.value = "auto";
  listExtractorInput.value = "";

  if (!parsed.hasDirective) {
    mode.value = "none";
  } else if (parsed.kind === "noRelation") {
    mode.value = "noRelation";
  } else if (parsed.kind === "enum") {
    mode.value = "enum";
    enumEntries.value = parsed.entries.map((entry) => ({ key: entry.key, label: entry.label }));
  } else if (parsed.kind === "slots") {
    mode.value = "slots";
    slotLabels.value = [...parsed.slots];
  } else if (parsed.kind === "relation" && parsed.relations.length) {
    const first = parsed.relations[0];
    mode.value = first.kind === "list" ? "list" : "value";
    targetTable.value = first.targetTable || "";
    targetColumn.value = first.targetColumn || "";
    const ext = String(first.extractor || "").trim();
    if (!ext) {
      listFormat.value = "auto";
    } else if (ext.toLowerCase() === "json") {
      listFormat.value = "json";
    } else if (ext === "," || ext === "，" || ext.toLowerCase() === "comma") {
      listFormat.value = "comma";
    } else if (ext === "|" || ext.toLowerCase() === "pipe") {
      listFormat.value = "pipe";
    } else if (ext.startsWith("$")) {
      listFormat.value = "path";
      listExtractorInput.value = ext;
    } else {
      listFormat.value = "member";
      listExtractorInput.value = ext;
    }
  } else {
    mode.value = "none";
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    initFromValue(props.value);
    void nextTick(() => {
      if (!isColumnKind.value) textareaRef.value?.focus();
    });
  },
  { immediate: true },
);

watch(
  () => [props.open, mode.value, targetTable.value],
  async () => {
    if (!props.open || !isColumnKind.value) return;
    if (mode.value !== "value" && mode.value !== "list") return;
    const rawName = targetTable.value.trim();
    const folded = rawName.toLowerCase();
    if (!folded || !matchedTargetTable.value) return;
    const existingCols = targetTableColumns.value;
    if (!existingCols.length && typeof props.loadTableColumns === "function") {
      const token = ++columnLoadToken;
      try {
        const cols = await props.loadTableColumns(matchedTargetTable.value.name);
        if (token !== columnLoadToken || !Array.isArray(cols)) return;
        loadedColumnsMap.value = { ...loadedColumnsMap.value, [folded]: cols };
      } catch {
        return;
      }
    }
    if (!targetColumn.value.trim()) {
      const cols = targetTableColumns.value;
      const pk = cols.find((col) => col.isPrimaryKey) || cols.find((col) => col.name.toLowerCase() === "id");
      if (pk) targetColumn.value = pk.name;
    }
  },
);

function selectMode(nextMode) {
  if (props.saving) return;
  mode.value = nextMode;
  if (nextMode === "enum") {
    const hasFilled = enumEntries.value.some((entry) => entry.key.trim() || entry.label.trim());
    if (!hasFilled) {
      if (suggestedEnumEntries.value.length) {
        enumEntries.value = suggestedEnumEntries.value.map((entry) => ({ key: entry.key, label: entry.label }));
      } else {
        enumEntries.value = [{ key: "", label: "" }, { key: "", label: "" }];
      }
    }
  } else if (nextMode === "slots") {
    const hasFilled = slotLabels.value.some((item) => String(item || "").trim());
    if (!hasFilled) {
      if (suggestedSlotLabels.value.length) {
        slotLabels.value = [...suggestedSlotLabels.value];
      } else {
        slotLabels.value = ["", ""];
      }
    }
  }
}

function addSlotRow() {
  slotLabels.value = [...slotLabels.value, ""];
}

function removeSlotRow(index) {
  const next = slotLabels.value.filter((_, idx) => idx !== index);
  slotLabels.value = next.length ? next : [""];
}

function applySuggestedSlots() {
  if (!suggestedSlotLabels.value.length) return;
  slotLabels.value = [...suggestedSlotLabels.value];
}

function addEnumRow() {
  enumEntries.value = [...enumEntries.value, { key: "", label: "" }];
}

function removeEnumRow(index) {
  const next = enumEntries.value.filter((_, idx) => idx !== index);
  enumEntries.value = next.length ? next : [{ key: "", label: "" }];
}

function applySuggestedEnums() {
  if (!suggestedEnumEntries.value.length) return;
  enumEntries.value = suggestedEnumEntries.value.map((entry) => ({ key: entry.key, label: entry.label }));
}

async function copyText(text, kind) {
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
    copiedKind.value = kind;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedKind.value = "";
      copiedTimer = 0;
    }, 1500);
  } catch {
    // Ignore clipboard rejection in restricted contexts.
  }
}

function copyForAgent() {
  const payload = formatAgentMeaningClipboard({
    database: props.database,
    tableName: props.tableName,
    columnName: props.name,
    currentComment: props.value,
    nextComment: finalComment.value,
    sampleValue: props.sampleValue,
  });
  void copyText(payload, "agent");
}

function copyComposedComment() {
  void copyText(finalComment.value, "comment");
}

function submit() {
  if (props.saving) return;
  if (props.readOnly) {
    if (!validationError.value) copyComposedComment();
    return;
  }
  if (validationError.value) return;
  emit("save", finalComment.value);
}

function onTextareaKeydown(event) {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || isImeKeyEvent(event)) return;
  event.preventDefault();
  event.stopPropagation();
  submit();
}

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = 0;
});
</script>

<template>
  <div
    v-if="open"
    class="wb-dialog-overlay"
    @click.stop
    @contextmenu.prevent.stop
  >
    <form
      ref="dialogRef"
      class="wb-dialog wb-comment-edit-dialog"
      :class="{ 'is-column-mode': isColumnKind }"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wb-comment-edit-title"
      aria-describedby="wb-comment-edit-subject"
      tabindex="-1"
      @submit.prevent="submit"
    >
      <header class="wb-dialog-header">
        <div class="wb-comment-edit-heading">
          <h2 id="wb-comment-edit-title">{{ t('m_2d22af42a79f') }}</h2>
          <p id="wb-comment-edit-subject" :title="subject">{{ subject }}</p>
        </div>
        <button
          type="button"
          class="wb-dialog-close"
          :aria-label="t('m_3fd47edce45b')"
          :disabled="saving"
          @click="emit('close')"
        ><X :size="16" aria-hidden="true" /></button>
      </header>
      <div class="wb-comment-edit-body">
        <section v-if="isColumnKind" class="wb-comment-meaning-box">
          <div class="wb-comment-meaning-head">
            <span class="wb-comment-meaning-label">{{ t('commentEdit.meaningSection') }}</span>
            <div class="wb-comment-mode-group" role="radiogroup" :aria-label="t('commentEdit.meaningSection')">
              <button
                v-for="item in MODES"
                :key="item"
                type="button"
                role="radio"
                class="wb-comment-mode-btn"
                :class="{ 'is-active': mode === item }"
                :aria-checked="String(mode === item)"
                :disabled="saving"
                @click="selectMode(item)"
              >{{ t(`commentEdit.mode.${item}`) }}</button>
            </div>
          </div>

          <p v-if="mode === 'none' || mode === 'noRelation'" class="wb-comment-meaning-hint">
            {{ t(`commentEdit.modeHint.${mode}`) }}
          </p>

          <div v-else-if="mode === 'enum'" class="wb-comment-enum-editor">
            <div class="wb-comment-enum-rows">
              <div v-for="(entry, index) in enumEntries" :key="index" class="wb-comment-enum-row">
                <input
                  v-model="entry.key"
                  type="text"
                  class="wb-comment-enum-key"
                  :placeholder="t('commentEdit.enumKeyPlaceholder')"
                  :disabled="saving"
                  spellcheck="false"
                />
                <span class="wb-comment-enum-eq" aria-hidden="true">=</span>
                <input
                  v-model="entry.label"
                  type="text"
                  class="wb-comment-enum-val"
                  :placeholder="t('commentEdit.enumLabelPlaceholder')"
                  :disabled="saving"
                  spellcheck="false"
                />
                <button
                  type="button"
                  class="wb-comment-enum-del"
                  :title="t('commentEdit.enumRemove')"
                  :aria-label="t('commentEdit.enumRemove')"
                  :disabled="saving"
                  @click="removeEnumRow(index)"
                ><Trash2 :size="13" aria-hidden="true" /></button>
              </div>
            </div>
            <div class="wb-comment-enum-tools">
              <button type="button" class="wb-comment-inline-btn" :disabled="saving" @click="addEnumRow">
                <Plus :size="12" aria-hidden="true" />
                <span>{{ t('commentEdit.enumAdd') }}</span>
              </button>
              <button
                v-if="suggestedEnumEntries.length"
                type="button"
                class="wb-comment-inline-btn is-accent"
                :disabled="saving"
                @click="applySuggestedEnums"
              >
                <Sparkles :size="12" aria-hidden="true" />
                <span>{{ t('commentEdit.enumExtract', { count: suggestedEnumEntries.length }) }}</span>
              </button>
              <div v-if="sampleEnumPreview.length" class="wb-comment-sample-preview">
                <span class="wb-comment-sample-label">{{ t('commentEdit.samplePreview', { value: sampleValue }) }}</span>
                <span
                  v-for="(item, idx) in sampleEnumPreview"
                  :key="idx"
                  class="wb-cell-detail-enum-chip"
                  :class="`is-${item.state}`"
                >
                  <Tag :size="10" aria-hidden="true" />
                  <span class="wb-cell-detail-ref-id">{{ item.value }}</span>
                  <span v-if="item.label" class="wb-cell-detail-ref-name">{{ item.label }}</span>
                  <span v-else class="wb-cell-detail-ref-missing">{{ t('cellDetail.enumUnmapped') }}</span>
                </span>
              </div>
            </div>
          </div>

          <div v-else-if="mode === 'slots'" class="wb-comment-enum-editor">
            <div class="wb-comment-enum-rows">
              <div v-for="(_, index) in slotLabels" :key="index" class="wb-comment-slot-row">
                <span class="wb-comment-slot-index">#{{ index + 1 }}</span>
                <input
                  v-model="slotLabels[index]"
                  type="text"
                  class="wb-comment-enum-val"
                  :placeholder="t('commentEdit.slotLabelPlaceholder', { index: index + 1 })"
                  :disabled="saving"
                  spellcheck="false"
                />
                <button
                  type="button"
                  class="wb-comment-enum-del"
                  :title="t('commentEdit.enumRemove')"
                  :aria-label="t('commentEdit.enumRemove')"
                  :disabled="saving"
                  @click="removeSlotRow(index)"
                ><Trash2 :size="13" aria-hidden="true" /></button>
              </div>
            </div>
            <div class="wb-comment-enum-tools">
              <button type="button" class="wb-comment-inline-btn" :disabled="saving" @click="addSlotRow">
                <Plus :size="12" aria-hidden="true" />
                <span>{{ t('commentEdit.slotAdd') }}</span>
              </button>
              <button
                v-if="suggestedSlotLabels.length"
                type="button"
                class="wb-comment-inline-btn is-accent"
                :disabled="saving"
                @click="applySuggestedSlots"
              >
                <Sparkles :size="12" aria-hidden="true" />
                <span>{{ t('commentEdit.enumExtract', { count: suggestedSlotLabels.length }) }}</span>
              </button>
            </div>
            <div v-if="sampleSlotPreview.length" class="wb-comment-sample-preview-row">
              <span class="wb-comment-sample-label">{{ t('commentEdit.samplePreview', { value: sampleValue }) }}</span>
              <span
                v-for="slot in sampleSlotPreview"
                :key="slot.index"
                class="wb-cell-detail-enum-chip"
                :class="`is-${slot.state}`"
              >
                <ListOrdered :size="10" aria-hidden="true" />
                <span class="wb-cell-detail-ref-name">{{ slot.label || `#${slot.index}` }}</span>
                <span class="wb-cell-detail-ref-id">{{ slot.value }}</span>
              </span>
            </div>
          </div>

          <div v-else-if="mode === 'value' || mode === 'list'" class="wb-comment-rel-editor">
            <div class="wb-comment-rel-grid">
              <label class="wb-comment-rel-field">
                <span>{{ t('commentEdit.targetTable') }}</span>
                <input
                  v-model="targetTable"
                  type="text"
                  :list="tableListId"
                  :placeholder="t('commentEdit.targetTablePlaceholder')"
                  :disabled="saving"
                  spellcheck="false"
                />
                <datalist :id="tableListId">
                  <option
                    v-for="table in normalizedTables"
                    :key="table.name"
                    :value="table.name"
                  >{{ table.comment ? `${table.name} — ${table.comment}` : table.name }}</option>
                </datalist>
              </label>
              <label class="wb-comment-rel-field">
                <span>{{ t('commentEdit.targetColumn') }}</span>
                <input
                  v-model="targetColumn"
                  type="text"
                  :list="columnListId"
                  :placeholder="t('commentEdit.targetColumnPlaceholder')"
                  :disabled="saving"
                  spellcheck="false"
                />
                <datalist :id="columnListId">
                  <option
                    v-for="col in targetTableColumns"
                    :key="col.name"
                    :value="col.name"
                  >{{ col.comment ? `${col.name} — ${col.comment}` : col.name }}</option>
                </datalist>
              </label>
            </div>
            <div v-if="mode === 'list'" class="wb-comment-rel-grid">
              <label class="wb-comment-rel-field">
                <span>{{ t('commentEdit.listFormat') }}</span>
                <select v-model="listFormat" :disabled="saving">
                  <option value="auto">{{ t('commentEdit.listFormat.auto') }}</option>
                  <option value="json">{{ t('commentEdit.listFormat.json') }}</option>
                  <option value="comma">{{ t('commentEdit.listFormat.comma') }}</option>
                  <option value="pipe">{{ t('commentEdit.listFormat.pipe') }}</option>
                  <option value="member">{{ t('commentEdit.listFormat.member') }}</option>
                  <option value="path">{{ t('commentEdit.listFormat.path') }}</option>
                </select>
              </label>
              <label v-if="listFormat === 'member' || listFormat === 'path'" class="wb-comment-rel-field">
                <span>{{ listFormat === 'member' ? t('commentEdit.listFormat.member') : t('commentEdit.listFormat.path') }}</span>
                <input
                  v-model="listExtractorInput"
                  type="text"
                  :placeholder="listFormat === 'member' ? t('commentEdit.listMemberPlaceholder') : t('commentEdit.listPathPlaceholder')"
                  :disabled="saving"
                  spellcheck="false"
                />
              </label>
            </div>
          </div>
        </section>

        <div class="wb-comment-prose-block">
          <div v-if="isColumnKind" class="wb-comment-prose-head">
            <label for="wb-comment-edit-textarea">{{ t('commentEdit.proseLabel') }}</label>
            <span
              class="wb-comment-length-counter"
              :class="{ 'is-over': finalComment.length > MAX_COLUMN_COMMENT_LENGTH }"
            >{{ finalComment.length }} / {{ MAX_COLUMN_COMMENT_LENGTH }}</span>
          </div>
          <textarea
            id="wb-comment-edit-textarea"
            ref="textareaRef"
            v-model="draft"
            :aria-label="t('m_daede9881787')"
            :placeholder="t('commentEdit.placeholder')"
            :disabled="saving"
            spellcheck="false"
            @keydown="onTextareaKeydown"
          ></textarea>
        </div>

        <div v-if="isColumnKind && directiveTag" class="wb-comment-directive-preview">
          <span class="wb-comment-directive-preview-label">{{ t('commentEdit.directivePreview') }}</span>
          <code>{{ directiveTag }}</code>
        </div>

        <p v-if="readOnly && isColumnKind" class="wb-comment-edit-notice" role="status">
          {{ t('commentEdit.readOnlyNotice') }}
        </p>

        <p v-if="validationError || error" class="wb-comment-edit-error" role="alert">
          <CircleAlert :size="15" aria-hidden="true" />
          <span>{{ validationError || error }}</span>
        </p>
      </div>
      <footer class="wb-dialog-actions">
        <span v-if="!saving && !readOnly" class="wb-comment-edit-shortcut">
          <span>{{ t('commentEdit.quickSave') }}</span>
          <kbd>{{ saveShortcut }}</kbd>
        </span>
        <button
          v-if="isColumnKind"
          type="button"
          class="wb-comment-copy-agent-btn"
          :disabled="saving || Boolean(validationError)"
          @click="copyForAgent"
        >
          <Check v-if="copiedKind === 'agent'" :size="13" aria-hidden="true" />
          <Copy v-else :size="13" aria-hidden="true" />
          <span>{{ copiedKind === 'agent' ? t('commentEdit.copied') : t('commentEdit.copyAgent') }}</span>
        </button>
        <button type="button" :disabled="saving" @click="emit('close')">{{ t('m_2cd0f3be8738') }}</button>
        <button
          v-if="readOnly && isColumnKind"
          type="button"
          class="wb-dialog-primary"
          :disabled="saving || Boolean(validationError)"
          @click="copyComposedComment"
        >
          {{ copiedKind === 'comment' ? t('commentEdit.copied') : t('commentEdit.copyComment') }}
        </button>
        <button
          v-else
          type="submit"
          class="wb-dialog-primary"
          :disabled="saving || Boolean(validationError)"
          aria-live="polite"
        >
          {{ t(saving ? 'm_ff509c9ba052' : 'm_4f8b0ab088ec') }}
        </button>
      </footer>
    </form>
  </div>
</template>
