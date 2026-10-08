// Whether the latest user interaction was a pointer press. Dialogs snapshot
// this when they open: a later Enter must not turn a mouse-opened control
// into a keyboard-focus ring.
let pointerActivated = false;
const installedTargets = new Set();

function isModifierKey(key) {
  return key === "Control" || key === "Shift" || key === "Alt" || key === "Meta";
}

export function notePointerInteraction() {
  pointerActivated = true;
}

export function noteKeyboardInteraction(event) {
  if (isModifierKey(event?.key)) return;
  pointerActivated = false;
}

export function interactionShowsFocusRing() {
  return !pointerActivated;
}

export function installFocusModalityTracking(target = globalThis.document) {
  if (!target?.addEventListener || installedTargets.has(target)) return;
  installedTargets.add(target);
  target.addEventListener("pointerdown", notePointerInteraction, true);
  target.addEventListener("keydown", noteKeyboardInteraction, true);
}

if (typeof document !== "undefined") installFocusModalityTracking(document);
