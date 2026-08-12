import { computed, reactive, ref, unref, watch } from "vue";

import {
  buildTableDesignPayload,
  normalizeTableDesign,
  validateTableDesignDraft,
} from "../utils/tableDesign.js";

function sourceIdentity(source = {}) {
  const raw = unref(source) || {};
  return {
    connectionId: String(raw.connectionId || raw.connection_id || ""),
    database: String(raw.database || ""),
    tableName: String(raw.tableName || raw.table_name || raw.name || ""),
  };
}

function sourceKey(identity = {}) {
  return [identity.connectionId, identity.database, identity.tableName]
    .map((value) => String(value || ""))
    .join("");
}

function sourceObject(source = {}) {
  const raw = unref(source);
  return raw && typeof raw === "object" ? raw : null;
}

function cloneDraft(draft = {}) {
  return {
    tableName: String(draft.tableName || ""),
    tableComment: String(draft.tableComment || ""),
    columns: Array.isArray(draft.columns)
      ? draft.columns.map((column) => ({ ...column }))
      : [],
  };
}

function replaceDraft(target, nextDraft) {
  const next = cloneDraft(nextDraft);
  target.tableName = next.tableName;
  target.tableComment = next.tableComment;
  target.columns.splice(0, target.columns.length, ...next.columns);
}

function draftSignature(draft = {}) {
  const normalized = cloneDraft(draft);
  normalized.columns = normalized.columns.map((column) => ({
    id: String(column.id || ""),
    originalName: String(column.originalName || ""),
    name: String(column.name || ""),
    type: String(column.type || ""),
    length: String(column.length || ""),
    scale: String(column.scale || ""),
    originalType: String(column.originalType || ""),
    nullable: Boolean(column.nullable),
    primaryKey: Boolean(column.primaryKey),
    primaryKeyOrdinal: column.primaryKey ? Number(column.primaryKeyOrdinal) || null : null,
    defaultMode: String(column.defaultMode || "none"),
    defaultValue: String(column.defaultValue ?? ""),
    comment: String(column.comment || ""),
  }));
  return JSON.stringify(normalized);
}

function emptyPreview() {
  return {
    signature: null,
    previewSignature: null,
    sourceSignature: null,
    schemaSignature: null,
    statements: [],
    warnings: [],
    conflicts: [],
    humanDescriptions: [],
  };
}

function clonePreview(value = {}) {
  if (!value || typeof value !== "object") return emptyPreview();
  return {
    ...emptyPreview(),
    ...value,
    statements: Array.isArray(value.statements) ? [...value.statements] : [],
    warnings: Array.isArray(value.warnings) ? [...value.warnings] : [],
    conflicts: Array.isArray(value.conflicts) ? [...value.conflicts] : [],
    humanDescriptions: Array.isArray(value.humanDescriptions) ? [...value.humanDescriptions] : [],
  };
}

function previewSignature(previewValue = {}) {
  return previewValue.previewSignature || previewValue.signature || "";
}

function schemaSignature(previewValue = {}) {
  return previewValue.schemaSignature || previewValue.sourceSignature || "";
}

function buildApplySignatures(previewValue = {}) {
  const signatures = {
    previewSignature: previewSignature(previewValue),
  };
  if (previewValue.schemaSignature) {
    signatures.schemaSignature = previewValue.schemaSignature;
  }
  if (previewValue.sourceSignature) {
    signatures.sourceSignature = previewValue.sourceSignature;
  }
  return signatures;
}

function storedDesignDraft(value) {
  if (!value || typeof value !== "object") return null;
  const normalized = normalizeTableDesign(value);
  if (!normalized.tableName && !normalized.tableComment && !normalized.columns.length) return null;
  return cloneDraft(normalized);
}

function storedDraft(value) {
  if (!value || typeof value !== "object") return null;
  const cloned = cloneDraft(value);
  if (!cloned.tableName && !cloned.tableComment && !cloned.columns.length) return null;
  return cloned;
}

function hasPreview(value = {}) {
  return Boolean(
    previewSignature(value) ||
    schemaSignature(value) ||
    value?.statements?.length ||
    value?.warnings?.length ||
    value?.conflicts?.length ||
    value?.humanDescriptions?.length,
  );
}

function previewConflicts(value = {}) {
  return Array.isArray(value?.conflicts) ? value.conflicts.filter(Boolean) : [];
}

function conflictErrorMessage(conflicts = []) {
  const first = conflicts[0] ? `：${conflicts[0]}` : "";
  return `检测到 ${conflicts.length} 处表设计冲突，无法保存${first}`;
}

export function useTableDesign(invokeWorkbench, source, { onApplied } = {}) {
  const loading = ref(false);
  const saving = ref(false);
  const error = ref("");
  const original = ref(null);
  const schema = ref(null);
  const draft = reactive({ tableName: "", tableComment: "", columns: [] });
  const validationErrors = ref(validateTableDesignDraft(draft));
  const preview = ref(emptyPreview());
  const previewOpen = ref(false);
  const cleanSignature = ref(draftSignature(draft));
  let loadRequestId = 0;
  let previewRequestId = 0;
  let applyRequestId = 0;

  const dirty = computed(() => draftSignature(draft) !== cleanSignature.value);

  function currentSourceObject() {
    return sourceObject(source);
  }

  function currentSourceKey() {
    return sourceKey(sourceIdentity(source));
  }

  function persistState(target = currentSourceObject()) {
    if (!target) return;
    if (original.value) target.design = cloneDraft(original.value);
    target.draft = cloneDraft(draft);
    target.dirty = dirty.value;
    target.preview = clonePreview(preview.value);
    target.loading = loading.value;
    target.saving = saving.value;
    target.error = error.value;
  }

  function hydrateFromSource(target = currentSourceObject()) {
    if (!target) return false;
    const savedOriginal = storedDesignDraft(target.design || target.original);
    const savedDraft = storedDraft(target.draft);
    if (!savedOriginal && !savedDraft) return false;

    const nextOriginal = savedOriginal || savedDraft;
    original.value = cloneDraft(nextOriginal);
    schema.value = target.schema || null;
    cleanSignature.value = draftSignature(nextOriginal);
    replaceDraft(draft, savedDraft || nextOriginal);
    validationErrors.value = validateTableDesignDraft(draft);
    preview.value = clonePreview(target.preview);
    previewOpen.value = hasPreview(preview.value);
    loading.value = Boolean(target.loading);
    saving.value = Boolean(target.saving);
    error.value = String(target.error || "");
    persistState(target);
    return true;
  }

  function clearPreview({ persist = true } = {}) {
    preview.value = emptyPreview();
    previewOpen.value = false;
    if (persist) persistState();
  }

  function isCurrentSource(target, requestSourceKey) {
    const currentTarget = currentSourceObject();
    const targetStillCurrent = target ? currentTarget === target : true;
    return targetStillCurrent && currentSourceKey() === requestSourceKey;
  }

  function isCurrentLoad(requestId, requestSourceKey) {
    return requestId === loadRequestId && currentSourceKey() === requestSourceKey;
  }

  function isCurrentPreview(requestId, target, requestSourceKey) {
    return requestId === previewRequestId && isCurrentSource(target, requestSourceKey);
  }

  function isCurrentApply(requestId, target, requestSourceKey) {
    return requestId === applyRequestId && isCurrentSource(target, requestSourceKey);
  }

  function finishSourceLoading(target, requestSourceKey) {
    if (target && sourceKey(sourceIdentity(target)) === requestSourceKey) {
      target.loading = false;
    }
  }

  function markSourceLoading(target) {
    if (!target) return;
    target.loading = true;
    target.error = "";
  }

  function finishSourceSaving(target, requestSourceKey) {
    if (target && sourceKey(sourceIdentity(target)) === requestSourceKey) {
      target.saving = false;
    }
  }

  function markSourceSaving(target) {
    if (!target) return;
    target.saving = true;
    target.error = "";
  }

  async function loadDesign({ force = false } = {}) {
    const target = currentSourceObject();
    const identity = sourceIdentity(source);
    const requestSourceKey = sourceKey(identity);
    if (!force && hydrateFromSource(target)) {
      return cloneDraft(draft);
    }

    const requestId = ++loadRequestId;
    loading.value = true;
    error.value = "";
    clearPreview({ persist: false });
    markSourceLoading(target);
    try {
      const result = await invokeWorkbench("get_table_design", identity);
      if (!isCurrentLoad(requestId, requestSourceKey)) return null;
      schema.value = result;
      const normalized = normalizeTableDesign(result);
      original.value = cloneDraft(normalized);
      replaceDraft(draft, normalized);
      cleanSignature.value = draftSignature(draft);
      validationErrors.value = validateTableDesignDraft(draft);
      clearPreview({ persist: false });
      return normalized;
    } catch (loadError) {
      if (!isCurrentLoad(requestId, requestSourceKey)) return null;
      error.value = String(loadError?.message || loadError);
      persistState(target);
      throw loadError;
    } finally {
      finishSourceLoading(target, requestSourceKey);
      if (requestId === loadRequestId) {
        loading.value = false;
        persistState(currentSourceObject());
      }
    }
  }

  function resetDraft() {
    if (!original.value) return;
    replaceDraft(draft, original.value);
    validationErrors.value = validateTableDesignDraft(draft);
    clearPreview();
    persistState();
  }

  async function previewDesign() {
    const target = currentSourceObject();
    const identity = sourceIdentity(source);
    const requestSourceKey = sourceKey(identity);
    const requestId = ++previewRequestId;
    error.value = "";
    const validation = validateTableDesignDraft(draft);
    validationErrors.value = validation;
    if (!validation.valid) {
      clearPreview();
      return null;
    }

    try {
      const result = await invokeWorkbench(
        "preview_table_design_change",
        buildTableDesignPayload(identity, draft),
      );
      if (!isCurrentPreview(requestId, target, requestSourceKey)) return null;
      preview.value = clonePreview(result || {});
      const conflicts = previewConflicts(preview.value);
      if (conflicts.length) {
        error.value = conflictErrorMessage(conflicts);
      }
      previewOpen.value = true;
      persistState(target);
      return preview.value;
    } catch (previewError) {
      if (!isCurrentPreview(requestId, target, requestSourceKey)) return null;
      error.value = String(previewError?.message || previewError);
      clearPreview();
      throw previewError;
    }
  }

  async function applyDesign() {
    const target = currentSourceObject();
    const identity = sourceIdentity(source);
    const requestSourceKey = sourceKey(identity);
    const requestId = ++applyRequestId;
    const signatures = buildApplySignatures(preview.value);
    const conflicts = previewConflicts(preview.value);
    if (conflicts.length) {
      const conflictError = conflictErrorMessage(conflicts);
      error.value = conflictError;
      persistState(target);
      throw new Error(conflictError);
    }
    if (!signatures.previewSignature || !schemaSignature(preview.value)) {
      const signatureError = "请先预览 SQL 并获取签名后再保存表设计";
      error.value = signatureError;
      persistState(target);
      throw new Error(signatureError);
    }

    saving.value = true;
    error.value = "";
    markSourceSaving(target);
    persistState(target);
    try {
      const payload = {
        ...buildTableDesignPayload(identity, draft),
        ...signatures,
      };
      const result = await invokeWorkbench("apply_table_design_change", payload);
      if (!isCurrentApply(requestId, target, requestSourceKey)) return null;
      const returnedSchema = result?.schema || result;
      schema.value = returnedSchema;
      const normalized = normalizeTableDesign(returnedSchema);
      original.value = cloneDraft(normalized);
      replaceDraft(draft, normalized);
      cleanSignature.value = draftSignature(draft);
      validationErrors.value = validateTableDesignDraft(draft);
      clearPreview({ persist: false });
      onApplied?.({ result, schema: returnedSchema, source: identity });
      return result;
    } catch (saveError) {
      if (!isCurrentApply(requestId, target, requestSourceKey)) return null;
      error.value = String(saveError?.message || saveError);
      throw saveError;
    } finally {
      finishSourceSaving(target, requestSourceKey);
      if (requestId === applyRequestId) {
        saving.value = false;
        persistState(currentSourceObject());
      }
    }
  }

  hydrateFromSource();

  watch(
    () => draftSignature(draft),
    (nextSignature, previousSignature) => {
      if (previousSignature !== undefined && nextSignature !== previousSignature && (hasPreview(preview.value) || error.value)) {
        clearPreview({ persist: false });
        error.value = "";
      }
      persistState();
    },
    { flush: "sync" },
  );

  // ── Column add/remove (#6) ────────────────────────────────────────────
  // A newly-added column carries an empty `originalName` so the backend DDL
  // diff emits ADD COLUMN. Existing columns omitted from the draft are
  // emitted as DROP COLUMN by the backend.
  function addColumn(index = null) {
    const column = {
      id: `col-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      originalName: "",
      name: "",
      type: "varchar",
      length: "255",
      scale: "",
      originalType: "",
      nullable: true,
      primaryKey: false,
      primaryKeyOrdinal: null,
      defaultMode: "none",
      defaultValue: "",
      comment: "",
    };
    if (index == null || index < 0 || index >= draft.columns.length) {
      draft.columns.push(column);
    } else {
      draft.columns.splice(index, 0, column);
    }
  }

  function removeColumn(index) {
    if (index < 0 || index >= draft.columns.length) return false;
    if (draft.columns.length <= 1) return false;
    draft.columns.splice(index, 1);
    normalizePrimaryKeyOrdinals();
    return true;
  }

  function normalizePrimaryKeyOrdinals() {
    draft.columns
      .filter((column) => column.primaryKey)
      .sort((left, right) => (left.primaryKeyOrdinal || Number.MAX_SAFE_INTEGER) - (right.primaryKeyOrdinal || Number.MAX_SAFE_INTEGER))
      .forEach((column, index) => {
        column.primaryKeyOrdinal = index + 1;
      });
    draft.columns
      .filter((column) => !column.primaryKey)
      .forEach((column) => {
        column.primaryKeyOrdinal = null;
      });
  }

  function togglePrimaryKey(column) {
    if (!column || !draft.columns.includes(column)) return false;
    if (column.primaryKey) {
      column.primaryKey = false;
      column.primaryKeyOrdinal = null;
      normalizePrimaryKeyOrdinals();
      return false;
    }
    const highestOrdinal = draft.columns.reduce(
      (highest, candidate) => Math.max(highest, candidate.primaryKeyOrdinal || 0),
      0,
    );
    column.primaryKey = true;
    column.primaryKeyOrdinal = highestOrdinal + 1;
    column.nullable = false;
    if (column.defaultMode === "null") {
      column.defaultMode = "none";
      column.defaultValue = "";
    }
    normalizePrimaryKeyOrdinals();
    return true;
  }

  function isNewColumn(column) {
    return String(column?.originalName || "").trim() === "";
  }

  return {
    loading,
    saving,
    error,
    original,
    schema,
    draft,
    dirty,
    validationErrors,
    preview,
    previewOpen,
    loadDesign,
    resetDraft,
    previewDesign,
    applyDesign,
    addColumn,
    removeColumn,
    togglePrimaryKey,
    isNewColumn,
  };
}
