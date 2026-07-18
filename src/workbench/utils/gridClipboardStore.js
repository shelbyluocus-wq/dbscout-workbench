function normalizeClipboardText(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function cloneMatrix(matrix) {
  return Array.isArray(matrix)
    ? matrix.map((row) => Array.isArray(row) ? row.map((value) => String(value ?? "")) : [])
    : null;
}

function cloneMask(mask) {
  return Array.isArray(mask)
    ? mask.map((row) => Array.isArray(row) ? row.map(Boolean) : [])
    : null;
}

function clonePayload(payload) {
  if (!payload) return null;
  return {
    ...payload,
    matrix: cloneMatrix(payload.matrix),
    mask: cloneMask(payload.mask),
    bounds: payload.bounds ? { ...payload.bounds } : null,
  };
}

let sharedPayload = null;

export function setGridClipboardPayload(text, payload = null) {
  sharedPayload = payload
    ? { ...clonePayload(payload), text: normalizeClipboardText(text) }
    : null;
}

export function getGridClipboardPayload(text) {
  if (!sharedPayload || sharedPayload.text !== normalizeClipboardText(text)) return null;
  return clonePayload(sharedPayload);
}

export function clearGridClipboardPayload() {
  sharedPayload = null;
}
