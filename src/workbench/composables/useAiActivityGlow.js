import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { listenWorkbenchEvent } from "../utils/tauriBridge.js";

const LINGER_MS = 1200;
const KIND_LABEL = { write: "AI 正在修改数据", ui: "AI 正在操作界面", read: "AI 正在读取" };
const KIND_RANK = { write: 3, ui: 2, read: 1 };

// Tracks external-MCP activity via `control-activity` window events. Active
// while any request is in flight and for 1200ms after the last one ends, so a
// tight loop of requests keeps a steady glow instead of flickering.
export function useAiActivityGlow({ now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = clearTimeout } = {}) {
  const inFlight = new Map();
  let lastEndAt = 0;
  let lastEndKind = "";
  let lingerTimer = null;
  const version = ref(0); // bump to recompute derived state

  function strongestKind() {
    let best = lastEndKind;
    for (const kind of inFlight.values()) {
      if ((KIND_RANK[kind] || 0) > (KIND_RANK[best] || 0)) best = kind;
    }
    return best;
  }

  function armLinger() {
    if (lingerTimer) return;
    lingerTimer = schedule(() => {
      lingerTimer = null;
      version.value += 1;
      if (inFlight.size || now() - lastEndAt < LINGER_MS) armLinger();
    }, LINGER_MS + 20);
  }

  function onEvent(payload) {
    const phase = String(payload?.phase || "");
    const kind = String(payload?.kind || "");
    const id = String(payload?.id || "");
    if (!KIND_RANK[kind]) return;
    if (phase === "start") {
      inFlight.set(id || `anon-${now()}-${inFlight.size}`, kind);
    } else if (phase === "end") {
      inFlight.delete(id);
      lastEndAt = now();
      lastEndKind = kind;
      armLinger();
    } else {
      return;
    }
    version.value += 1;
  }

  const active = computed(() => {
    void version.value;
    return inFlight.size > 0 || (now() - lastEndAt < LINGER_MS && Boolean(lastEndKind));
  });
  const kind = computed(() => {
    void version.value;
    return strongestKind() || "read";
  });
  const level = computed(() => (kind.value === "write" ? "write" : "calm"));
  const label = computed(() => (active.value ? KIND_LABEL[kind.value] || "" : ""));

  let unlisten = null;
  onMounted(async () => {
    unlisten = await listenWorkbenchEvent("control-activity", (event) => onEvent(event?.payload ?? event));
  });
  onBeforeUnmount(() => {
    if (lingerTimer) cancel(lingerTimer);
    unlisten?.();
  });

  return { active, level, label, onEvent };
}
