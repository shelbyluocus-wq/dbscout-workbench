export function resolveTargetBounds(sourceBounds, direction, fillCount) {
  if (!sourceBounds || !Number.isInteger(fillCount) || fillCount <= 0) return null;
  if (direction === "down") {
    return {
      top: sourceBounds.bottom + 1,
      bottom: sourceBounds.bottom + fillCount,
      left: sourceBounds.left,
      right: sourceBounds.right,
    };
  }
  if (direction === "up") {
    return {
      top: sourceBounds.top - fillCount,
      bottom: sourceBounds.top - 1,
      left: sourceBounds.left,
      right: sourceBounds.right,
    };
  }
  if (direction === "right") {
    return {
      top: sourceBounds.top,
      bottom: sourceBounds.bottom,
      left: sourceBounds.right + 1,
      right: sourceBounds.right + fillCount,
    };
  }
  if (direction === "left") {
    return {
      top: sourceBounds.top,
      bottom: sourceBounds.bottom,
      left: sourceBounds.left - fillCount,
      right: sourceBounds.left - 1,
    };
  }
  return null;
}

export function resolvePixelAxisDelta({ pointerX, pointerY, sourceRect } = {}) {
  if (
    !sourceRect
    || !Number.isFinite(pointerX)
    || !Number.isFinite(pointerY)
    || !Number.isFinite(sourceRect.left)
    || !Number.isFinite(sourceRect.right)
    || !Number.isFinite(sourceRect.top)
    || !Number.isFinite(sourceRect.bottom)
  ) {
    return null;
  }
  let vertical = 0;
  if (pointerY > sourceRect.bottom) vertical = pointerY - sourceRect.bottom;
  else if (pointerY < sourceRect.top) vertical = sourceRect.top - pointerY;

  let horizontal = 0;
  if (pointerX > sourceRect.right) horizontal = pointerX - sourceRect.right;
  else if (pointerX < sourceRect.left) horizontal = sourceRect.left - pointerX;

  return { vertical, horizontal };
}

export function clampRectToViewport(rawRect, viewport, { minTop = viewport.contentTop, minLeft = viewport.contentLeft } = {}) {
  if (!rawRect || !viewport) return null;
  const clipTop = Math.max(viewport.contentTop, minTop);
  const clipBottom = viewport.contentBottom;
  const clipLeft = Math.max(viewport.contentLeft, minLeft);
  const clipRight = viewport.contentRight;

  const left = Math.max(rawRect.left, clipLeft);
  const right = Math.min(rawRect.right, clipRight);
  const top = Math.max(rawRect.top, clipTop);
  const bottom = Math.min(rawRect.bottom, clipBottom);

  if (right - left < 1 || bottom - top < 1) return null;

  return {
    left: left - viewport.contentLeft,
    top: top - viewport.contentTop,
    width: right - left,
    height: bottom - top,
    clientLeft: left,
    clientTop: top,
    clientRight: right,
    clientBottom: bottom,
    clippedTop: rawRect.top < clipTop - 0.5,
    clippedBottom: rawRect.bottom > clipBottom + 0.5,
    clippedLeft: rawRect.left < clipLeft - 0.5,
    clippedRight: rawRect.right > clipRight + 0.5,
  };
}

export function resolveFillPreviewTipPosition({
  previewRect,
  direction,
  pointer = null,
  viewport,
  shellRect,
  tipWidth = 148,
  tipHeight = 28,
} = {}) {
  if (!viewport || !shellRect) return null;
  const marginX = 6;
  const marginY = 4;
  const offsetX = 10;
  const offsetY = 8;

  const hasPointer = Number.isFinite(pointer?.x) && Number.isFinite(pointer?.y);
  let rawX;
  let rawY;

  if (previewRect) {
    if (direction === "down" || direction === "up") {
      const rightCandidate = previewRect.clientRight + offsetX;
      const leftCandidate = previewRect.clientLeft - tipWidth - offsetX;
      rawX = rightCandidate + tipWidth <= viewport.contentRight - marginX
        ? rightCandidate
        : (leftCandidate >= viewport.contentLeft + marginX ? leftCandidate : rightCandidate);
      const anchorY = direction === "up"
        ? previewRect.clientTop
        : previewRect.clientBottom - tipHeight;
      if (hasPointer) {
        const minY = Math.min(previewRect.clientTop, previewRect.clientBottom - tipHeight);
        const maxY = Math.max(previewRect.clientTop, previewRect.clientBottom - tipHeight);
        rawY = Math.max(minY, Math.min(pointer.y - tipHeight / 2, maxY));
      } else {
        rawY = anchorY;
      }
    } else {
      const bottomCandidate = previewRect.clientBottom + offsetY;
      const topCandidate = previewRect.clientTop - tipHeight - offsetY;
      rawY = bottomCandidate + tipHeight <= viewport.contentBottom - marginY
        ? bottomCandidate
        : (topCandidate >= viewport.contentTop + marginY ? topCandidate : bottomCandidate);
      const anchorX = direction === "left"
        ? previewRect.clientLeft
        : previewRect.clientRight - tipWidth;
      if (hasPointer) {
        const minX = Math.min(previewRect.clientLeft, previewRect.clientRight - tipWidth);
        const maxX = Math.max(previewRect.clientLeft, previewRect.clientRight - tipWidth);
        rawX = Math.max(minX, Math.min(pointer.x + 12, maxX));
      } else {
        rawX = anchorX;
      }
    }
  } else if (hasPointer) {
    rawX = pointer.x + 14;
    rawY = pointer.y + 14;
  } else {
    rawX = viewport.contentRight - tipWidth - marginX;
    rawY = viewport.contentBottom - tipHeight - marginY;
  }

  const maxLeft = Math.max(viewport.contentLeft + marginX, viewport.contentRight - tipWidth - marginX);
  const maxTop = Math.max(viewport.contentTop + marginY, viewport.contentBottom - tipHeight - marginY);
  const clampedX = Math.max(viewport.contentLeft + marginX, Math.min(rawX, maxLeft));
  const clampedY = Math.max(viewport.contentTop + marginY, Math.min(rawY, maxTop));

  return {
    left: Math.round(clampedX - shellRect.left),
    top: Math.round(clampedY - shellRect.top),
  };
}
