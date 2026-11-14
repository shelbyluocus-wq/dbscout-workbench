import { nextTick, onBeforeUnmount, watch } from "vue";
import { fitToolbar } from "../utils/toolbarFit.js";

/**
 * Keeps a toolbar at the fullest layout that fits (see `fitToolbar`).
 * Refits when the toolbar is resized and when `contentSignature` changes,
 * since chips, hit counts or a new language widen the row without resizing it.
 */
export function useToolbarFit(elementRef, { maxLevel, contentSignature }) {
  let observer = null;
  const refit = () => fitToolbar(elementRef.value, maxLevel);

  watch(elementRef, (element) => {
    observer?.disconnect();
    observer = null;
    if (!element) return;
    refit();
    if (typeof ResizeObserver === "undefined") return;
    observer = new ResizeObserver(refit);
    observer.observe(element);
  }, { flush: "post" });

  watch(contentSignature, () => nextTick(refit));

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return { refit };
}
