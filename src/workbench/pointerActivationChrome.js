const watches = new WeakMap();

export function isPointerButtonActivation(event) {
  return Boolean(event && event.detail > 0 && event.currentTarget);
}

export function pointerStillOverElement(element, point) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect || !point) return false;
  return point.clientX >= rect.left && point.clientX <= rect.right
    && point.clientY >= rect.top && point.clientY <= rect.bottom;
}

// A mouse click focuses the button. Enter then paints :focus-visible (the
// accent fill and tooltip) when the opened surface closes. Drop that focus,
// and keep the idle look until the pointer actually leaves the button.
// Keyboard activation (detail 0) is left alone so its focus ring stays.
export function retainPointerActivationChrome(event, onRelease) {
  if (!isPointerButtonActivation(event)) return false;
  const button = event.currentTarget;
  button.blur?.();
  const target = event.view || globalThis;
  watches.get(button)?.();

  const stop = () => {
    target.removeEventListener?.("pointermove", onMove, true);
    if (watches.get(button) === stop) watches.delete(button);
  };
  const onMove = (move) => {
    if (pointerStillOverElement(button, move)) return;
    stop();
    onRelease?.();
  };
  watches.set(button, stop);
  target.addEventListener?.("pointermove", onMove, true);
  return true;
}
