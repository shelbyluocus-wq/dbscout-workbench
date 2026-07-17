import { computed, onBeforeUnmount, onMounted, ref } from "vue";

// The quick-open entry floats above the right edge of the pane tab strip
// (see --wb-titlebar-tab-right-clearance in workbench.css). Instead of
// relying on hand-tuned pixel constants — the button's rendered width varies
// across platforms, fonts and the narrow-window media queries — measure the
// real button width with a ResizeObserver and feed it back into the CSS var
// so the tab strip always clears the button exactly.
const BUTTON_RIGHT_MARGIN_PX = 8;
const VISUAL_GAP_PX = 8;

export function useQuickOpenClearance() {
  const quickOpenEntryRef = ref(null);
  const entryWidth = ref(0);
  let resizeObserver = null;

  function measureEntry() {
    entryWidth.value = quickOpenEntryRef.value?.offsetWidth || 0;
  }

  onMounted(() => {
    measureEntry();
    if (typeof ResizeObserver === "undefined" || !quickOpenEntryRef.value) return;
    resizeObserver = new ResizeObserver(measureEntry);
    resizeObserver.observe(quickOpenEntryRef.value);
  });

  onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
  });

  const quickOpenClearanceVars = computed(() => (
    entryWidth.value > 0
      ? {
        "--wb-quick-open-entry-clearance":
          `${Math.ceil(entryWidth.value) + BUTTON_RIGHT_MARGIN_PX + VISUAL_GAP_PX}px`,
      }
      : {}
  ));

  return { quickOpenEntryRef, quickOpenClearanceVars };
}
