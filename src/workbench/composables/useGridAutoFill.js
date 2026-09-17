import { computed, ref, shallowRef } from "vue";
import { canUseFillHandle, resolveFillPreview } from "../utils/gridAutoFill.js";

export function useGridAutoFill() {
  const isFilling = ref(false);
  const fillPreview = ref(null);
  const fillSession = shallowRef(null);
  const fillOptions = ref(null);

  const hasFillPreview = computed(() => Boolean(isFilling.value && fillPreview.value?.fillCount > 0));
  const fillSourceBounds = computed(() => fillSession.value?.sourceBounds || null);

  function beginFillSession({ sourceBounds, sourceMatrix, copyKey = false } = {}) {
    if (!sourceBounds || !Array.isArray(sourceMatrix) || sourceMatrix.length === 0) return false;
    isFilling.value = true;
    fillOptions.value = null;
    fillSession.value = {
      sourceBounds: { ...sourceBounds },
      sourceMatrix,
      copyKey: Boolean(copyKey),
    };
    fillPreview.value = { fillCount: 0, previewBounds: { ...sourceBounds } };
    return true;
  }

  function updateFillPreview(rowIndex, columnIndex, limits = {}) {
    const session = fillSession.value;
    if (!isFilling.value || !session) return null;
    const preview = resolveFillPreview(session.sourceBounds, rowIndex, columnIndex, limits);
    fillPreview.value = preview;
    return preview;
  }

  function takeFillRequest(copyKey = false) {
    const session = fillSession.value;
    const preview = fillPreview.value;
    isFilling.value = false;
    fillSession.value = null;
    fillPreview.value = null;
    if (!session || !preview?.fillCount || !preview.direction) return null;
    return {
      sourceBounds: session.sourceBounds,
      sourceMatrix: session.sourceMatrix,
      direction: preview.direction,
      fillCount: preview.fillCount,
      previewBounds: preview.previewBounds,
      mode: (session.copyKey || copyKey) ? "copy" : "auto",
    };
  }

  function cancelFillSession() {
    isFilling.value = false;
    fillSession.value = null;
    fillPreview.value = null;
  }

  function rememberFillOptions(context) {
    fillOptions.value = context ? { ...context } : null;
  }

  function clearFillOptions() {
    fillOptions.value = null;
  }

  function canShowFillHandle({ selection, readOnly = false, editing = false, rowSelected = false, tabId } = {}) {
    if (isFilling.value || rowSelected) return false;
    if (tabId && selection?.tabId !== tabId) return false;
    return canUseFillHandle(selection, { readOnly, editing });
  }

  return {
    isFilling,
    fillPreview,
    fillSourceBounds,
    fillOptions,
    hasFillPreview,
    beginFillSession,
    updateFillPreview,
    takeFillRequest,
    cancelFillSession,
    rememberFillOptions,
    clearFillOptions,
    canShowFillHandle,
  };
}
