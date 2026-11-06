import { onBeforeUnmount, onMounted } from "vue";

export function useMacosTrafficLights({ enabled, getScale, invoke }) {
  let titlebar = null;
  let observer = null;
  let frame = 0;

  function sync(scale = getScale()) {
    if (!enabled || !titlebar) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      const titlebarHeight = titlebar.getBoundingClientRect().height * scale;
      if (titlebarHeight < 20 || titlebarHeight > 160) return;
      void invoke("macos_align_traffic_lights", { titlebarHeight }).catch((error) => {
        console.error("[macosTrafficLights] alignment failed:", error);
      });
    });
  }

  const onResize = () => sync();
  onMounted(() => {
    if (!enabled) return;
    titlebar = document.querySelector(".wb-titlebar");
    if (!titlebar) return;
    observer = new ResizeObserver(onResize);
    observer.observe(titlebar);
    window.addEventListener("resize", onResize);
    window.addEventListener("focus", onResize);
    sync();
  });
  onBeforeUnmount(() => {
    observer?.disconnect();
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("focus", onResize);
    titlebar = null;
  });
  return sync;
}
