import { computed, ref, shallowRef } from "vue";
import { canUseFillHandle, describeFillPreview, resolveFillPreview } from "../utils/gridAutoFill.js";

function axisForDirection(direction) {
  if (direction === "down" || direction === "up") return "vertical";
  if (direction === "left" || direction === "right") return "horizontal";
  return null;
}

function sameFillPreview(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.direction !== right.direction || left.fillCount !== right.fillCount) return false;
  const a = left.previewBounds;
  const b = right.previewBounds;
  if (a === b) return true;
  if (!a || !b) return false;
  return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;
}

export function useGridAutoFill() {
  const isFilling = ref(false);
  const fillPreview = shallowRef(null);
  const fillSession = shallowRef(null);
  const fillModifierActive = ref(false);
  const fillOptions = ref(null);
  let lastPreviewAxis = null;

  const hasFillPreview = computed(() => Boolean(isFilling.value && fillPreview.value?.fillCount > 0));
  const fillSourceBounds = computed(() => fillSession.value?.sourceBounds || null);
  const fillPreviewDetail = computed(() => {
    const session = fillSession.value;
    const preview = fillPreview.value;
    if (!isFilling.value || !session || !preview?.fillCount || !preview.direction) return null;
    return describeFillPreview({
      sourceMatrix: session.sourceMatrix,
      direction: preview.direction,
      fillCount: preview.fillCount,
      mode: fillModifierActive.value ? "toggle" : "auto",
    });
  });

  function beginFillSession({ sourceBounds, sourceMatrix, toggleKey, copyKey = false } = {}) {
    if (!sourceBounds || !Array.isArray(sourceMatrix) || sourceMatrix.length === 0) return false;
    const initialModifier = toggleKey !== undefined ? Boolean(toggleKey) : Boolean(copyKey);
    isFilling.value = true;
    fillOptions.value = null;
    fillModifierActive.value = initialModifier;
    lastPreviewAxis = null;
    fillSession.value = {
      sourceBounds: { ...sourceBounds },
      sourceMatrix,
    };
    fillPreview.value = { fillCount: 0, previewBounds: { ...sourceBounds } };
    return true;
  }

  function setFillModifier(active) {
    if (!isFilling.value) return;
    const next = Boolean(active);
    if (fillModifierActive.value === next) return;
    fillModifierActive.value = next;
  }

  function updateFillPreview(rowIndex, columnIndex, limits = {}) {
    const session = fillSession.value;
    if (!isFilling.value || !session) return null;
    const nextLimits = limits.previousAxis !== undefined
      ? limits
      : (lastPreviewAxis ? { ...limits, previousAxis: lastPreviewAxis } : limits);
    const preview = resolveFillPreview(session.sourceBounds, rowIndex, columnIndex, nextLimits);
    lastPreviewAxis = preview.fillCount > 0 ? axisForDirection(preview.direction) : null;
    if (sameFillPreview(fillPreview.value, preview)) return fillPreview.value;
    fillPreview.value = preview;
    return preview;
  }

  function takeFillRequest(modifierOverride) {
    const session = fillSession.value;
    const preview = fillPreview.value;
    const activeModifier = modifierOverride !== undefined
      ? Boolean(modifierOverride)
      : fillModifierActive.value;
    isFilling.value = false;
    fillSession.value = null;
    fillPreview.value = null;
    fillModifierActive.value = false;
    lastPreviewAxis = null;
    if (!session || !preview?.fillCount || !preview.direction) return null;
    return {
      sourceBounds: session.sourceBounds,
      sourceMatrix: session.sourceMatrix,
      direction: preview.direction,
      fillCount: preview.fillCount,
      previewBounds: preview.previewBounds,
      mode: activeModifier ? "toggle" : "auto",
    };
  }

  function cancelFillSession() {
    isFilling.value = false;
    fillSession.value = null;
    fillPreview.value = null;
    fillModifierActive.value = false;
    lastPreviewAxis = null;
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
    fillModifierActive,
    fillPreviewDetail,
    fillOptions,
    hasFillPreview,
    beginFillSession,
    setFillModifier,
    updateFillPreview,
    takeFillRequest,
    cancelFillSession,
    rememberFillOptions,
    clearFillOptions,
    canShowFillHandle,
  };
}
