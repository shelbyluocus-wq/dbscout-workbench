export function visibleTargetScrollDelta({
  containerTop,
  containerBottom,
  targetTop,
  targetBottom,
  occluderTop = null,
  gap = 0,
}) {
  const top = Number(containerTop);
  const bottom = Number(containerBottom);
  const itemTop = Number(targetTop);
  const itemBottom = Number(targetBottom);
  if (![top, bottom, itemTop, itemBottom].every(Number.isFinite) || bottom <= top) return 0;

  const hasOccluder = occluderTop !== null
    && occluderTop !== undefined
    && occluderTop !== ''
    && Number.isFinite(Number(occluderTop));
  const overlayTop = hasOccluder ? Number(occluderTop) : null;
  const visibleBottom = hasOccluder
    ? Math.min(bottom, overlayTop - Math.max(0, Number(gap) || 0))
    : bottom;
  const visibleHeight = Math.max(0, visibleBottom - top);
  const targetHeight = Math.max(0, itemBottom - itemTop);

  if (itemTop < top) return itemTop - top;
  if (itemBottom <= visibleBottom) return 0;
  if (targetHeight > visibleHeight) return itemTop - top;
  return itemBottom - visibleBottom;
}
