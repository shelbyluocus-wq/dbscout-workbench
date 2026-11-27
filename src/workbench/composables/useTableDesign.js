import { computed, reactive, ref, unref, watch } from "vue";

import {
  buildTableDesignPayload,
  normalizeTableDesign,
  validateTableDesignDraft,
} from "../utils/tableDesign.js";
import { columnsForPaste } from "../utils/tableDesignClipboard.js";
import { initialCreateTableDraft, validateCreateTableDraft, createTablePayload } from "../utils/createTable.js";

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
    .join(" ");
}

function sourceObject(source = {}) {
  const raw = unref(source);
  return raw && typeof raw === "object" ? raw : null;
}

function cloneIndex(index = {}) {
  return {
    id: String(index.id || ""),
    originalName: String(index.originalName || ""),
    name: String(index.name || ""),
    indexType: String(index.indexType || "INDEX"),
    columns: Array.isArray(index.columns) ? [...index.columns] : [],
    comment: String(index.comment || ""),
  };
}

function cloneDraft(draft = {}) {
  return {
    tableName: String(draft.tableName || ""),
    tableComment: String(draft.tableComment || ""),
    engine: String(draft.engine || ""),
    charset: String(draft.charset || ""),
    collation: String(draft.collation || ""),
    columns: Array.isArray(draft.columns)
      ? draft.columns.map((column) => ({ ...column }))
      : [],
    indexes: Array.isArray(draft.indexes)
      ? draft.indexes.map(cloneIndex)
      : [],
  };
}

function replaceDraft(target, nextDraft) {
  const next = cloneDraft(nextDraft);
  target.tableName = next.tableName;
  target.tableComment = next.tableComment;
  target.engine = next.engine;
  target.charset = next.charset;
  target.collation = next.collation;
  target.columns.splice(0, target.columns.length, ...next.columns);
  target.indexes.splice(0, target.indexes.length, ...next.indexes);
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
    unsigned: Boolean(column.unsigned),
    autoIncrement: Boolean(column.autoIncrement),
    nullable: Boolean(column.nullable),
    primaryKey: Boolean(column.primaryKey),
    primaryKeyOrdinal: column.primaryKey ? Number(column.primaryKeyOrdinal) || null : null,
    defaultMode: String(column.defaultMode || "none"),
    defaultValue: String(column.defaultValue ?? ""),
    comment: String(column.comment || ""),
  }));
  normalized.indexes = normalized.indexes.map((index) => ({
    id: String(index.id || ""),
    originalName: String(index.originalName || ""),
    name: String(index.name || ""),
    indexType: String(index.indexType || "INDEX").toUpperCase(),
    columns: Array.isArray(index.columns) ? index.columns.map((c) => String(c || "")) : [],
    comment: String(index.comment || ""),
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
  return `发现 ${conflicts.length} 个字段存在无法转换的现有值，暂不能保存${first}`;
}

// A design tab can be remounted while an IPC preview is still pending. Keep
// ownership outside the composable instance so a retired instance can never
// publish its late draft/preview back into the shared tab object.
const previewOperationBySource = new WeakMap();
let previewOperationSequence = 0;

export function useTableDesign(invokeWorkbench, source, { onApplied } = {}) {
  const loading = ref(false);
  const previewing = ref(false);
  const saving = ref(false);
  const error = ref("");
  const original = ref(null);
  const schema = ref(null);
  const draft = reactive({ tableName: "", tableComment: "", engine: "", charset: "", collation: "", columns: [], indexes: [] });
  const validationErrors = ref(validateTableDesignDraft(draft));
  const preview = ref(emptyPreview());
  const previewOpen = ref(false);
  const cleanSignature = ref(draftSignature(draft));
  let loadRequestId = 0;
  let applyRequestId = 0;
  let applyingTarget = null;
  const instanceToken = {};
  let activePreviewOperation = null;
  const creating = computed(() => Boolean(sourceObject(source)?.createMode));
  const validateDraft = () => creating.value ? validateCreateTableDraft(draft) : validateTableDesignDraft(draft);

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
    target.previewing = previewing.value;
    target.saving = saving.value;
    target.error = error.value;
  }

  function hydrateFromSource(target = currentSourceObject()) {
    if (!target) return false;
    invalidateSourcePreview(target, { persist: false });
    const savedOriginal = creating.value ? storedDraft(target.design || target.original) : storedDesignDraft(target.design || target.original);
    const savedDraft = storedDraft(target.draft);
    if (!savedOriginal && !savedDraft) {
      target.previewing = false;
      return false;
    }

    const nextOriginal = savedOriginal || (creating.value ? initialCreateTableDraft() : savedDraft);
    const savedPreview = clonePreview(target.preview);
    const savedError = String(target.error || "");
    loading.value = Boolean(target.loading);
    saving.value = Boolean(target.saving);
    previewing.value = false;
    original.value = cloneDraft(nextOriginal);
    schema.value = target.schema || null;
    cleanSignature.value = draftSignature(nextOriginal);
    replaceDraft(draft, savedDraft || nextOriginal);
    validationErrors.value = validateTableDesignDraft(draft);
    preview.value = savedPreview;
    previewOpen.value = hasPreview(preview.value);
    target.previewing = false;
    error.value = savedError;
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

  function ownsPreviewOperation(operation) {
    if (!operation || activePreviewOperation !== operation) return false;
    if (!operation.target) return true;
    return previewOperationBySource.get(operation.target) === operation;
  }

  function isCurrentPreview(operation, target, requestSourceKey) {
    return ownsPreviewOperation(operation) && isCurrentSource(target, requestSourceKey);
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

  function requestBackendPreviewCancellation(operation) {
    if (!operation?.validationId || operation.cancellationSent) return;
    operation.cancellationSent = true;
    try {
      Promise.resolve(invokeWorkbench("cancel_table_design_validation", {
        validationId: operation.validationId,
      })).catch(() => {});
    } catch {
      // Logical cancellation still prevents stale state publication. The
      // backend command is best-effort for browser mocks and older runtimes.
    }
  }

  function invalidatePreviewOperation(operation, { notifyBackend = true, persist = true } = {}) {
    if (!operation) return false;
    const ownsTarget = !operation.target || previewOperationBySource.get(operation.target) === operation;
    if (ownsTarget && operation.target) {
      previewOperationBySource.delete(operation.target);
      operation.target.previewing = false;
    }
    if (activePreviewOperation === operation) {
      activePreviewOperation = null;
      previewing.value = false;
    }
    if (notifyBackend) requestBackendPreviewCancellation(operation);
    if (persist && isCurrentSource(operation.target, operation.requestSourceKey)) {
      persistState(operation.target);
    }
    return ownsTarget;
  }

  function invalidateSourcePreview(target, options = {}) {
    const operation = target
      ? previewOperationBySource.get(target)
      : activePreviewOperation;
    return invalidatePreviewOperation(operation, options);
  }

  function markSourcePreviewing(target, operation) {
    if (!target) return;
    target.previewing = true;
    target.error = "";
    previewOperationBySource.set(target, operation);
  }

  async function loadDesign({ force = false } = {}) {
    const target = currentSourceObject();
    if (activePreviewOperation) {
      invalidatePreviewOperation(activePreviewOperation, { persist: false });
    }
    invalidateSourcePreview(target, { persist: false });
    const identity = sourceIdentity(source);
    const requestSourceKey = sourceKey(identity);
    if (creating.value) {
      if (hydrateFromSource(target)) return cloneDraft(draft);
      const initial = initialCreateTableDraft();
      original.value = cloneDraft(initial);
      replaceDraft(draft, initial);
      cleanSignature.value = draftSignature(initial);
      validationErrors.value = { valid: true, columns: [], indexes: [], messages: [] };
      persistState(target);
      return cloneDraft(draft);
    }
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
    error.value = "";
    const validation = validateDraft();
    validationErrors.value = validation;
    if (!validation.valid) {
      clearPreview();
      return null;
    }

    const requestDraftSignature = draftSignature(draft);
    invalidateSourcePreview(target, { persist: false });
    const operation = {
      owner: instanceToken,
      target,
      requestSourceKey,
      validationId: `table-design-${Date.now()}-${++previewOperationSequence}`,
      cancellationSent: false,
    };
    activePreviewOperation = operation;
    previewing.value = true;
    markSourcePreviewing(target, operation);
    persistState(target);
    try {
      const result = await invokeWorkbench(
        creating.value ? "preview_create_table" : "preview_table_design_change",
        creating.value ? { request: createTablePayload(identity, draft) } : {
          ...buildTableDesignPayload(identity, draft),
          validationId: operation.validationId,
        },
      );
      if (
        !isCurrentPreview(operation, target, requestSourceKey)
        || draftSignature(draft) !== requestDraftSignature
      ) return null;
      preview.value = clonePreview(result || {});
      const conflicts = previewConflicts(preview.value);
      if (conflicts.length) {
        error.value = conflictErrorMessage(conflicts);
      }
      previewOpen.value = true;
      persistState(target);
      return preview.value;
    } catch (previewError) {
      if (
        !isCurrentPreview(operation, target, requestSourceKey)
        || draftSignature(draft) !== requestDraftSignature
      ) return null;
      error.value = String(previewError?.message || previewError);
      clearPreview();
      throw previewError;
    } finally {
      if (ownsPreviewOperation(operation)) {
        if (target) previewOperationBySource.delete(target);
        activePreviewOperation = null;
        if (target) target.previewing = false;
        previewing.value = false;
        if (isCurrentSource(target, requestSourceKey)) persistState(target);
      } else if (activePreviewOperation === operation) {
        activePreviewOperation = null;
        previewing.value = false;
      }
    }
  }

  function cancelPreview() {
    const target = currentSourceObject();
    const operation = activePreviewOperation || (target ? previewOperationBySource.get(target) : null);
    if (!operation) return false;
    error.value = "";
    return invalidatePreviewOperation(operation);
  }

  function dispose() {
    if (activePreviewOperation?.owner === instanceToken) {
      invalidatePreviewOperation(activePreviewOperation, { persist: false });
    }
  }

  async function applyDesign() {
    if (saving.value) return null;
    const target = currentSourceObject();
    const identity = sourceIdentity(source);
    const requestSourceKey = sourceKey(identity);
    const requestId = ++applyRequestId;
    const wasCreating = creating.value;
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
    applyingTarget = target;
    error.value = "";
    markSourceSaving(target);
    persistState(target);
    try {
      const payload = {
        ...buildTableDesignPayload(identity, draft),
        ...signatures,
      };
      const result = await invokeWorkbench(wasCreating ? "create_table" : "apply_table_design_change", wasCreating ? {
        request: { ...createTablePayload(identity, draft), previewSignature: signatures.previewSignature, confirmed: true },
      } : payload);
      const current = isCurrentApply(requestId, target, requestSourceKey);
      if (!current && !wasCreating) return null;
      const returnedSchema = result?.schema || result;
      const normalized = normalizeTableDesign(returnedSchema);
      if (wasCreating && target) {
        target.design = cloneDraft(normalized);
        target.draft = cloneDraft(normalized);
        target.schema = returnedSchema;
        target.dirty = false;
        target.saving = false;
        target.preview = emptyPreview();
        target.error = "";
      }
      if (!current) {
        if (wasCreating && target) finishCreatedSource(target, normalized.tableName);
        onApplied?.({ result, schema: returnedSchema, source: { ...identity, tableName: normalized.tableName }, created: wasCreating, tabId: target?.id });
        return result;
      }
      schema.value = returnedSchema;
      original.value = cloneDraft(normalized);
      replaceDraft(draft, normalized);
      cleanSignature.value = draftSignature(draft);
      validationErrors.value = validateTableDesignDraft(draft);
      clearPreview({ persist: false });
      if (wasCreating && target) finishCreatedSource(target, normalized.tableName);
      onApplied?.({ result, schema: returnedSchema, source: { ...identity, tableName: normalized.tableName }, created: wasCreating, tabId: target?.id });
      return result;
    } catch (saveError) {
      if (wasCreating && target) {
        target.error = String(saveError?.message || saveError);
        target.preview = emptyPreview();
        target.saving = false;
      }
      if (!isCurrentApply(requestId, target, requestSourceKey)) return null;
      error.value = String(saveError?.message || saveError);
      throw saveError;
    } finally {
      applyingTarget = null;
      finishSourceSaving(target, requestSourceKey);
      if (requestId === applyRequestId) {
        saving.value = false;
        persistState(currentSourceObject());
      }
    }
  }

  function finishCreatedSource(target, tableName) {
    target.createMode = false;
    target.tableName = tableName;
    target.tableKey = sourceKey(sourceIdentity(target));
    target.tabKey = ["design", target.tableKey].join("\u001f");
  }

  hydrateFromSource();

  watch(
    () => currentSourceObject()?.saving,
    (pending) => {
      const target = currentSourceObject();
      if (!pending && saving.value && target && applyingTarget !== target) hydrateFromSource(target);
    },
  );

  watch(
    () => draftSignature(draft),
    (nextSignature, previousSignature) => {
      if (previousSignature !== undefined && nextSignature !== previousSignature) {
        invalidateSourcePreview(currentSourceObject(), { persist: false });
        if (hasPreview(preview.value) || error.value) {
          clearPreview({ persist: false });
          error.value = "";
        }
      }
      persistState();
    },
    { flush: "sync" },
  );

  // ── Column add/remove (#6) ────────────────────────────────────────────
  // A newly-added column carries an empty `originalName` so the backend DDL
  // diff emits ADD COLUMN. Existing columns omitted from the draft are
  // emitted as DROP COLUMN by the backend.
  function snapshotColumns(indexes = []) {
    return (Array.isArray(indexes) ? indexes : [])
      .map((index) => draft.columns[index])
      .filter(Boolean)
      .map((column) => ({
        name: String(column.name ?? ""),
        type: String(column.type ?? ""),
        length: String(column.length ?? ""),
        scale: String(column.scale ?? ""),
        unsigned: Boolean(column.unsigned),
        autoIncrement: Boolean(column.autoIncrement),
        nullable: Boolean(column.nullable),
        defaultMode: String(column.defaultMode || "none"),
        defaultValue: String(column.defaultValue ?? ""),
        comment: String(column.comment || ""),
      }));
  }

  function pasteColumns(copiedColumns = [], { afterIndex = null } = {}) {
    const next = columnsForPaste(copiedColumns, draft.columns);
    if (!next.length) return [];
    const insertAt = afterIndex == null || afterIndex < 0 || afterIndex >= draft.columns.length
      ? draft.columns.length
      : afterIndex + 1;
    draft.columns.splice(insertAt, 0, ...next);
    return next;
  }

  function addColumn(index = null) {
    const column = {
      id: `col-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      originalName: "",
      name: "",
      type: "varchar",
      length: "255",
      scale: "",
      originalType: "",
      unsigned: false,
      autoIncrement: false,
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
    const [removed] = draft.columns.splice(index, 1);
    const removedLower = String(removed?.name || "").trim().toLowerCase();
    if (removedLower) {
      draft.indexes.forEach((idx) => {
        idx.columns = idx.columns.filter((col) => String(col || "").trim().toLowerCase() !== removedLower);
      });
    }
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

  function toggleAutoIncrement(column) {
    if (!column || !draft.columns.includes(column)) return false;
    column.autoIncrement = !column.autoIncrement;
    if (column.autoIncrement) {
      column.nullable = false;
      column.defaultMode = "none";
      column.defaultValue = "";
    }
    return column.autoIncrement;
  }

  function addIndex() {
    const existingNames = new Set(draft.indexes.map((item) => String(item.name || "").toLowerCase()));
    let suffix = draft.indexes.length + 1;
    let candidate = `idx_${suffix}`;
    while (existingNames.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `idx_${suffix}`;
    }
    draft.indexes.push({
      id: `idx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      originalName: "",
      name: candidate,
      indexType: "INDEX",
      columns: [],
      comment: "",
    });
  }

  function removeIndex(index) {
    if (index < 0 || index >= draft.indexes.length) return false;
    draft.indexes.splice(index, 1);
    return true;
  }

  function addIndexColumn(indexItem, columnName) {
    const name = String(columnName || "").trim();
    if (!indexItem || !name) return false;
    if (indexItem.columns.some((col) => String(col || "").toLowerCase() === name.toLowerCase())) {
      return false;
    }
    indexItem.columns.push(name);
    return true;
  }

  function removeIndexColumn(indexItem, colIdx) {
    if (!indexItem || colIdx < 0 || colIdx >= indexItem.columns.length) return false;
    indexItem.columns.splice(colIdx, 1);
    return true;
  }

  function moveIndexColumn(indexItem, colIdx, delta) {
    if (!indexItem) return false;
    const nextIdx = colIdx + delta;
    if (colIdx < 0 || nextIdx < 0 || colIdx >= indexItem.columns.length || nextIdx >= indexItem.columns.length) {
      return false;
    }
    const [moved] = indexItem.columns.splice(colIdx, 1);
    indexItem.columns.splice(nextIdx, 0, moved);
    return true;
  }

  function isNewColumn(column) {
    return String(column?.originalName || "").trim() === "";
  }

  return {
    creating,
    loading,
    previewing,
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
  };
}
