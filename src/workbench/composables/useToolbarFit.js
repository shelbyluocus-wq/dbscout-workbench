import { getCurrentInstance, inject, nextTick, onBeforeUnmount, watch } from "vue";
import { fitToolbar } from "../utils/toolbarFit.js";

/**
 * Keeps a toolbar at the fullest layout that fits (see `fitToolbar`).
 * Refits when the toolbar is resized and when `contentSignature` changes,
 * since chips, hit counts or a new language widen the row without resizing it.
 *
 * While a pane collapse/expand animation is running, resize-driven refits are
 * deferred until the animation settles so each frame avoids multi-pass forced
 * layout reads on the toolbar.
 */
export function useToolbarFit(elementRef, { maxLevel, contentSignature, suspended = null }) {
  const suspendRef = suspended ?? (getCurrentInstance() ? inject("suspendGridAutoFit", null) : null);
  let observer = null;
  let pendingRefit = false;
  const refit = () => {
    pendingRefit = false;
    return fitToolbar(elementRef.value, maxLevel);
  };
  const onResize = () => {
    if (suspendRef?.value) {
      pendingRefit = true;
      return;
    }
    refit();
  };

  watch(elementRef, (element) => {
    observer?.disconnect();
    observer = null;
    if (!element) return;
    refit();
    if (typeof ResizeObserver === "undefined") return;
    observer = new ResizeObserver(onResize);
    observer.observe(element);
  }, { flush: "post" });

  watch(contentSignature, () => nextTick(refit));

  if (suspendRef) {
    watch(
      () => Boolean(suspendRef.value),
      (isSuspended) => {
        if (isSuspended || !pendingRefit) return;
        pendingRefit = false;
        nextTick(refit);
      },
    );
  }

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return { refit };
}
