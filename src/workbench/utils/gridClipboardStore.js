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
    columnNames: Array.isArray(payload.columnNames) ? payload.columnNames.map(String) : null,
  };
}

let sharedPayload = null;
let listenersInstalled = false;
const INTERNAL_CLIPBOARD_MAX_AGE_MS = 5 * 60 * 1000;

function clearExpiredPayload() {
  if (sharedPayload && Date.now() - sharedPayload.createdAt > INTERNAL_CLIPBOARD_MAX_AGE_MS) {
    clearGridClipboardPayload();
  }
}

function installClipboardBoundaryListeners() {
  if (listenersInstalled || typeof window === "undefined") return;
  listenersInstalled = true;
  window.addEventListener("blur", clearGridClipboardPayload);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) clearGridClipboardPayload();
    });
  }
}

export function setGridClipboardPayload(text, payload = null) {
  installClipboardBoundaryListeners();
  sharedPayload = payload
    ? { ...clonePayload(payload), text: normalizeClipboardText(text), createdAt: Date.now() }
    : null;
}

export function getGridClipboardPayload(text) {
  clearExpiredPayload();
  if (!sharedPayload || sharedPayload.text !== normalizeClipboardText(text)) return null;
  return clonePayload(sharedPayload);
}

// Used by contextual row actions. Desktop mode validates the system clipboard;
// browser mode uses this snapshot because clipboard reads require extra permission.
export function peekGridClipboardPayload() {
  clearExpiredPayload();
  return sharedPayload ? clonePayload(sharedPayload) : null;
}

export function clearGridClipboardPayload() {
  sharedPayload = null;
}
