import { interactionShowsFocusRing } from "./focusModality.js";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isFocusable(element) {
  if (!element || typeof element.focus !== "function") return false;
  if (element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;
  if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return false;
  return true;
}

function focusableElements(layer) {
  const root = layer?.dialogRef?.value;
  if (!root?.querySelectorAll) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isFocusable);
}

function preferredInitialFocus(layer) {
  const root = layer?.dialogRef?.value;
  if (!root?.querySelector) return null;
  const preferred = root.querySelector([
    "[autofocus]",
    "input:not([disabled]):not([type='hidden'])",
    "textarea:not([disabled])",
    "select:not([disabled])",
  ].join(","));
  if (isFocusable(preferred)) return preferred;
  return focusableElements(layer)[0] || null;
}

export function createDialogLayerManager(getDocument = () => globalThis.document) {
  const layers = [];
  let listeningDocument = null;

  function top() {
    return layers.at(-1) || null;
  }

  function stopEvent(event) {
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
  }

  function trapFocus(event, layer) {
    const root = layer?.dialogRef?.value;
    if (!root) return false;
    const items = focusableElements(layer);
    if (!items.length) {
      stopEvent(event);
      root.focus?.({ preventScroll: true });
      return true;
    }

    const documentTarget = getDocument();
    const active = documentTarget?.activeElement;
    const first = items[0];
    const last = items.at(-1);
    if (!root.contains?.(active) || !items.includes(active)) {
      stopEvent(event);
      (event.shiftKey ? last : first).focus?.({ preventScroll: true });
      return true;
    }
    if (event.shiftKey && active === first) {
      stopEvent(event);
      last.focus?.({ preventScroll: true });
      return true;
    }
    if (!event.shiftKey && active === last) {
      stopEvent(event);
      first.focus?.({ preventScroll: true });
      return true;
    }
    return false;
  }

  function handleKeydown(event) {
    const layer = top();
    if (!layer) return false;
    if (event.key === "Tab") {
      if (layer.modal === false) return false;
      if (!event.defaultPrevented) return trapFocus(event, layer);
      event.stopImmediatePropagation?.();
      event.stopPropagation?.();
      return true;
    }
    if (event.key !== "Escape") {
      if (layer.modal === false) return false;
      const shortcutLike = event.ctrlKey || event.metaKey || event.altKey || /^F(?:[1-9]|1[0-2])$/.test(event.key);
      if (!shortcutLike) return false;
      // Target-level handlers and native text editing have already had their
      // turn. Stop shortcut-shaped events at the active dialog boundary so
      // older document listeners behind the dialog cannot act on them. Do not
      // preventDefault here: Ctrl+C/V/Z and AltGr input must keep working.
      event.stopImmediatePropagation?.();
      event.stopPropagation?.();
      return true;
    }

    // An editor or nested popover handled Escape first. Keep the event away
    // from global workbench shortcuts, but do not close the surrounding dialog.
    if (event.defaultPrevented) {
      event.stopImmediatePropagation?.();
      event.stopPropagation?.();
      return true;
    }

    stopEvent(event);
    if (layer.isBusy?.()) return true;
    layer.close?.();
    return true;
  }

  function ensureListener() {
    const documentTarget = getDocument();
    if (!documentTarget?.addEventListener || listeningDocument === documentTarget) return;
    listeningDocument?.removeEventListener?.("keydown", handleKeydown);
    listeningDocument = documentTarget;
    // Bubble phase lets an input, editor, or nested popover consume Escape
    // first. Active dialog roots also own the same listener, so events from a
    // dialog are stopped before older document-level workbench listeners run.
    listeningDocument.addEventListener("keydown", handleKeydown);
  }

  function releaseListenerWhenIdle() {
    if (layers.length || !listeningDocument) return;
    listeningDocument.removeEventListener?.("keydown", handleKeydown);
    listeningDocument = null;
  }

  function attachRootListener(layer) {
    if (layer?.modal === false) return;
    const root = layer?.dialogRef?.value;
    if (!root?.addEventListener || layer.listeningRoot === root) return;
    layer.listeningRoot?.removeEventListener?.("keydown", handleKeydown);
    layer.listeningRoot = root;
    root.addEventListener("keydown", handleKeydown);
  }

  function detachRootListener(layer) {
    layer?.listeningRoot?.removeEventListener?.("keydown", handleKeydown);
    if (layer) layer.listeningRoot = null;
  }

  function activate(layer) {
    const existing = layers.indexOf(layer);
    if (existing >= 0) layers.splice(existing, 1);
    const documentTarget = getDocument();
    layer.returnFocus = documentTarget?.activeElement || null;
    // Snapshot the opener's modality now. The Enter that closes the dialog
    // must not paint a keyboard focus ring on a control the user clicked.
    layer.returnFocusVisible = interactionShowsFocusRing();
    layers.push(layer);
    ensureListener();
  }

  function deactivate(layer) {
    const index = layers.indexOf(layer);
    if (index < 0) return { wasTop: false, nextTop: top(), returnFocus: null };
    const wasTop = index === layers.length - 1;
    layers.splice(index, 1);
    detachRootListener(layer);
    const result = {
      wasTop,
      nextTop: top(),
      returnFocus: layer.returnFocus || null,
      returnFocusVisible: layer.returnFocusVisible !== false,
    };
    layer.returnFocus = null;
    layer.returnFocusVisible = undefined;
    releaseListenerWhenIdle();
    return result;
  }

  function focusLayer(layer) {
    if (top() !== layer || layer?.modal === false) return false;
    attachRootListener(layer);
    const root = layer?.dialogRef?.value;
    const documentTarget = getDocument();
    if (!root || root.contains?.(documentTarget?.activeElement)) return false;
    const target = preferredInitialFocus(layer) || root;
    target.focus?.({ preventScroll: true });
    return true;
  }

  function restoreFocus({ wasTop, nextTop, returnFocus, returnFocusVisible }) {
    if (!wasTop || top() !== nextTop) return false;
    if (returnFocus?.isConnected === false) return false;
    if (typeof returnFocus?.focus !== "function") return false;
    returnFocus.focus({ preventScroll: true, focusVisible: returnFocusVisible !== false });
    return true;
  }

  function focusCurrentLayer() {
    return focusLayer(top());
  }

  return {
    activate,
    deactivate,
    focusCurrentLayer,
    focusLayer,
    handleKeydown,
    hasActiveLayer: () => layers.length > 0,
    hasActiveModalLayer: () => layers.some((layer) => layer.modal !== false),
    restoreFocus,
    size: () => layers.length,
    top,
  };
}

export const dialogLayerManager = createDialogLayerManager();
