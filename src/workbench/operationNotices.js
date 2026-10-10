import { reactive } from "vue";

// How long each tone stays on screen. Errors linger so they can be read and
// copied; hovering or focusing a notice pauses its timer.
export const NOTICE_DURATION_MS = Object.freeze({ success: 3200, info: 3600, warning: 5600, error: 9000 });
export const NOTICE_LIMIT = 3;
// The same event often arrives twice (an explicit feedback call plus the
// status text it also wrote); within this window the copies merge silently.
export const NOTICE_COALESCE_MS = 800;
// A message already shown beside a cell is not repeated as a notice.
export const NOTICE_SUPPRESS_MS = 1500;

const TONES = new Set(["error", "warning", "success", "info"]);
const TONE_RANK = Object.freeze({ info: 0, success: 1, warning: 2, error: 3 });

function normalize(text) {
  return String(text ?? "").trim();
}

// Notice queue for operation feedback. The UI renders `state.items`; callers
// push structured notices and never manage timers themselves.
export function createOperationNotices({
  schedule = (callback, ms) => globalThis.setTimeout?.(callback, ms),
  cancel = (handle) => globalThis.clearTimeout?.(handle),
  now = () => Date.now(),
  limit = NOTICE_LIMIT,
  durations = NOTICE_DURATION_MS,
} = {}) {
  const state = reactive({ items: [] });
  const timers = new Map();
  const suppressed = new Map();
  let nextId = 1;

  function find(id) {
    return state.items.find((item) => item.id === id) || null;
  }

  function disarm(id) {
    if (!timers.has(id)) return;
    cancel(timers.get(id));
    timers.delete(id);
  }

  function arm(item) {
    disarm(item.id);
    if (item.paused) return;
    const ms = item.duration ?? durations[item.tone] ?? durations.info;
    if (!(ms > 0)) return;
    timers.set(item.id, schedule(() => dismiss(item.id), ms));
  }

  function isSuppressed(text) {
    const until = suppressed.get(text);
    if (until === undefined) return false;
    if (until >= now()) return true;
    suppressed.delete(text);
    return false;
  }

  function moveToEnd(item) {
    const index = state.items.indexOf(item);
    if (index >= 0 && index !== state.items.length - 1) {
      state.items.splice(index, 1);
      state.items.push(item);
    }
  }

  function push({ tone = "info", text = "", detail = "", duration } = {}) {
    const message = normalize(text);
    if (!message || isSuppressed(message)) return null;
    const resolvedTone = TONES.has(tone) ? tone : "info";
    const extra = normalize(detail);
    const timestamp = now();
    const recent = (item) => timestamp - item.updatedAt <= NOTICE_COALESCE_MS;

    // A short title arriving right after the detailed text it summarizes
    // takes over as the title and keeps that text as its detail.
    const summarized = extra && extra !== message
      ? state.items.find((item) => item.text === extra && recent(item))
      : null;
    if (summarized) {
      summarized.detail = summarized.text;
      summarized.text = message;
      if (TONE_RANK[resolvedTone] > TONE_RANK[summarized.tone]) summarized.tone = resolvedTone;
      summarized.updatedAt = timestamp;
      moveToEnd(summarized);
      arm(summarized);
      return summarized.id;
    }

    const sameEvent = state.items.find((item) => item.detail === message
      || (item.text === message && recent(item)));
    const repeated = sameEvent ? null : state.items.find((item) => item.text === message);
    const existing = sameEvent || repeated;
    if (existing) {
      if (repeated) existing.count += 1;
      if (extra && extra !== existing.text && !existing.detail) existing.detail = extra;
      if (TONE_RANK[resolvedTone] > TONE_RANK[existing.tone]) existing.tone = resolvedTone;
      existing.updatedAt = timestamp;
      moveToEnd(existing);
      arm(existing);
      return existing.id;
    }

    const item = {
      id: nextId++,
      tone: resolvedTone,
      text: message,
      detail: extra && extra !== message ? extra : "",
      count: 1,
      paused: false,
      duration,
      updatedAt: timestamp,
    };
    state.items.push(item);
    while (state.items.length > Math.max(1, limit)) dismiss(state.items[0].id);
    arm(find(item.id) || item);
    return item.id;
  }

  function dismiss(id) {
    disarm(id);
    const index = state.items.findIndex((item) => item.id === id);
    if (index >= 0) state.items.splice(index, 1);
  }

  function pause(id) {
    const item = find(id);
    if (!item || item.paused) return;
    item.paused = true;
    disarm(id);
  }

  function resume(id) {
    const item = find(id);
    if (!item || !item.paused) return;
    item.paused = false;
    arm(item);
  }

  // Marks a message as already presented elsewhere (e.g. beside a cell).
  function suppress(text, ms = NOTICE_SUPPRESS_MS) {
    const message = normalize(text);
    if (message) suppressed.set(message, now() + ms);
  }

  function clear() {
    for (const item of [...state.items]) dismiss(item.id);
  }

  return { state, push, dismiss, pause, resume, suppress, clear };
}
