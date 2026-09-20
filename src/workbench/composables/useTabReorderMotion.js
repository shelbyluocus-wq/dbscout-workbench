import { nextTick, watch } from "vue";

// Measure tabs only while reordering, never during navigation or data updates.
export function useTabReorderMotion(root, tabs, dragging) {
  watch(tabs, async () => {
    if (!dragging.value || !root.value || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const before = new Map([...root.value.children].map((node) => [node, node.getBoundingClientRect().left]));
    await nextTick();
    for (const [node, left] of before) {
      if (!node.isConnected) continue;
      const delta = left - node.getBoundingClientRect().left;
      if (delta) node.animate?.([{ transform: `translateX(${delta}px)` }, { transform: "translateX(0)" }], {
        duration: 140, easing: "ease-out",
      });
    }
  }, { flush: "pre" });
}
