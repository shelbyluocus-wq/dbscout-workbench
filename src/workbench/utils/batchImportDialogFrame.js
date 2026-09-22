export const BATCH_IMPORT_DIALOG_MIN_WIDTH = 640;
export const BATCH_IMPORT_DIALOG_MIN_HEIGHT = 420;
export const BATCH_IMPORT_DIALOG_INSET = 16;
export const BATCH_IMPORT_DIALOG_FRAME_KEY = "dbscout_batch_import_dialog_frame_v1";

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function viewSize(viewport) {
  return {
    width: Math.max(0, Number(viewport?.width) || 0),
    height: Math.max(0, Number(viewport?.height) || 0),
  };
}

function frameOptions(options = {}) {
  return {
    inset: options.inset ?? BATCH_IMPORT_DIALOG_INSET,
    minWidth: options.minWidth ?? BATCH_IMPORT_DIALOG_MIN_WIDTH,
    minHeight: options.minHeight ?? BATCH_IMPORT_DIALOG_MIN_HEIGHT,
  };
}

function safeMinimum(minSize, viewLength, inset) {
  return Math.min(minSize, Math.max(0, viewLength - inset * 2));
}

export function clampDialogFrame(frame, viewport, options) {
  const { inset, minWidth, minHeight } = frameOptions(options);
  const view = viewSize(viewport);
  const maxWidth = Math.max(0, view.width - inset * 2);
  const maxHeight = Math.max(0, view.height - inset * 2);
  const width = clamp(Number(frame?.width) || 0, safeMinimum(minWidth, view.width, inset), maxWidth);
  const height = clamp(Number(frame?.height) || 0, safeMinimum(minHeight, view.height, inset), maxHeight);
  return {
    left: Math.round(clamp(Number(frame?.left) || inset, inset, Math.max(inset, view.width - inset - width))),
    top: Math.round(clamp(Number(frame?.top) || inset, inset, Math.max(inset, view.height - inset - height))),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function resizeDialogFrame(start, delta, edges = {}, viewport, options) {
  const { inset, minWidth, minHeight } = frameOptions(options);
  const view = viewSize(viewport);
  const safeMinWidth = safeMinimum(minWidth, view.width, inset);
  const safeMinHeight = safeMinimum(minHeight, view.height, inset);
  const startRight = start.left + start.width;
  const startBottom = start.top + start.height;
  let left = edges.left ? start.left + delta.x : start.left;
  let right = edges.right ? startRight + delta.x : startRight;
  let top = edges.top ? start.top + delta.y : start.top;
  let bottom = edges.bottom ? startBottom + delta.y : startBottom;

  left = clamp(left, inset, view.width - inset);
  right = clamp(right, inset, view.width - inset);
  top = clamp(top, inset, view.height - inset);
  bottom = clamp(bottom, inset, view.height - inset);

  if (right - left < safeMinWidth) {
    if (edges.left && !edges.right) left = right - safeMinWidth;
    else right = left + safeMinWidth;
  }
  if (bottom - top < safeMinHeight) {
    if (edges.top && !edges.bottom) top = bottom - safeMinHeight;
    else bottom = top + safeMinHeight;
  }

  if (left < inset) {
    right += inset - left;
    left = inset;
  }
  if (right > view.width - inset) {
    left -= right - (view.width - inset);
    right = view.width - inset;
  }
  if (top < inset) {
    bottom += inset - top;
    top = inset;
  }
  if (bottom > view.height - inset) {
    top -= bottom - (view.height - inset);
    bottom = view.height - inset;
  }

  left = clamp(left, inset, view.width - inset);
  right = clamp(right, left, view.width - inset);
  top = clamp(top, inset, view.height - inset);
  bottom = clamp(bottom, top, view.height - inset);

  const roundedLeft = Math.round(left);
  const roundedTop = Math.round(top);
  return {
    left: roundedLeft,
    top: roundedTop,
    width: Math.max(0, Math.round(right) - roundedLeft),
    height: Math.max(0, Math.round(bottom) - roundedTop),
  };
}

function finiteFrame(value) {
  const left = Number(value?.left);
  const top = Number(value?.top);
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (![left, top, width, height].every((item) => Number.isFinite(item) && item >= 0)) return null;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

export function loadBatchImportDialogFrame(storage, viewport, options) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(BATCH_IMPORT_DIALOG_FRAME_KEY) || "null");
    if (parsed?.version !== 1) return null;
    const frame = finiteFrame(parsed);
    if (!frame) return null;
    return clampDialogFrame(frame, viewport, options);
  } catch {
    return null;
  }
}

export function saveBatchImportDialogFrame(frame, storage) {
  const safe = finiteFrame(frame);
  if (!safe) return;
  try {
    storage?.setItem?.(BATCH_IMPORT_DIALOG_FRAME_KEY, JSON.stringify({ version: 1, ...safe }));
  } catch {
    // A failed preference write must not interrupt resizing.
  }
}
