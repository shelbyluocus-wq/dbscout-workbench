function normalizePosition(position) {
  return position === "after" ? "after" : "before";
}

export function previewDragOrder(list, sourceId, targetId, { position = "before", getKey = (item) => item } = {}) {
  const items = Array.isArray(list) ? [...list] : [];
  const normalizedPosition = normalizePosition(position);
  const sourceIndex = items.findIndex((item) => String(getKey(item)) === String(sourceId));
  const targetIndex = items.findIndex((item) => String(getKey(item)) === String(targetId));
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;

  const [sourceItem] = items.splice(sourceIndex, 1);
  const targetIndexAfterRemoval = items.findIndex((item) => String(getKey(item)) === String(targetId));
  const insertIndex = normalizedPosition === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval;
  items.splice(insertIndex, 0, sourceItem);
  return items;
}

export function sameDragTarget(target, kind, id, position = "before") {
  return (
    target?.kind === kind &&
    String(target?.id ?? "") === String(id ?? "") &&
    normalizePosition(target?.position) === normalizePosition(position)
  );
}

export function resolvePreviewDropTarget(dragState, fallbackTargetId, fallbackPosition = "before") {
  if (dragState?.targetId && String(dragState.targetId) !== String(dragState.sourceId ?? "")) {
    return { targetId: dragState.targetId, position: normalizePosition(dragState.targetPosition) };
  }
  return { targetId: fallbackTargetId, position: normalizePosition(fallbackPosition) };
}
