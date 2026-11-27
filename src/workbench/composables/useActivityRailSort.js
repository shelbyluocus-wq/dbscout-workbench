import { nextTick, ref } from "vue";

// Pointer travel before a press becomes a drag; below it the press stays a click.
export const RAIL_SORT_THRESHOLD = 4;
export const RAIL_SORT_SETTLE_MS = 180;
// How far past the first/last slot the lifted entry can stretch, and how much
// of the overshoot it follows.
const RUBBER_BAND_LIMIT = 10;
const RUBBER_BAND_RATIO = 0.3;

// `slots` are the resting `{ top, height }` boxes of the sortable entries, in
// rendered order, measured once when the drag starts.
export function clampRailSortOffset(slots, sourceIndex, offset) {
  if (!slots.length || !slots[sourceIndex]) return 0;
  const min = slots[0].top - slots[sourceIndex].top;
  const max = slots[slots.length - 1].top - slots[sourceIndex].top;
  const stretch = (over) => Math.min(RUBBER_BAND_LIMIT, over * RUBBER_BAND_RATIO);
  if (offset < min) return min - stretch(min - offset);
  if (offset > max) return max + stretch(offset - max);
  return offset;
}

export function railSortTargetIndex(slots, sourceIndex, offset) {
  const source = slots[sourceIndex];
  if (!source) return sourceIndex;
  const center = source.top + source.height / 2 + offset;
  let target = sourceIndex;
  let best = Infinity;
  slots.forEach((slot, index) => {
    const distance = Math.abs(slot.top + slot.height / 2 - center);
    if (distance < best) {
      best = distance;
      target = index;
    }
  });
  return target;
}

// The slot the lifted entry is held over closely enough to drop into it
// (its middle part, not the edges that reorder), or -1.
export const RAIL_SORT_INTO_RATIO = 0.3;

export function railSortIntoIndex(slots, sourceIndex, offset, canDropInto) {
  const source = slots[sourceIndex];
  if (!source || typeof canDropInto !== "function") return -1;
  const center = source.top + source.height / 2 + offset;
  return slots.findIndex((slot, index) => (
    index !== sourceIndex
    && slot
    && canDropInto(index)
    && Math.abs(slot.top + slot.height / 2 - center) <= slot.height * RAIL_SORT_INTO_RATIO
  ));
}

// Vertical shift for a non-dragged entry so the gap opens at `targetIndex`.
export function railSortSiblingShift(slots, sourceIndex, targetIndex, index) {
  if (index === sourceIndex || !slots[index]) return 0;
  if (sourceIndex < targetIndex && index > sourceIndex && index <= targetIndex) {
    return slots[index - 1].top - slots[index].top;
  }
  if (sourceIndex > targetIndex && index < sourceIndex && index >= targetIndex) {
    return slots[index + 1].top - slots[index].top;
  }
  return 0;
}

function prefersReducedMotion() {
  return Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function nextFrame(callback) {
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf === "function") raf(() => raf(callback));
  else setTimeout(callback, 0);
}

/**
 * Press-and-drag reordering for the activity rail tool group.
 *
 * Phases: idle → pending (pressed, under threshold) → dragging (entry lifted,
 * siblings slide to open a gap) → settling (entry glides into its slot) →
 * resetting (new order committed with transitions off, so nothing jumps) → idle.
 */
export function useActivityRailSort({
  items,
  container,
  onReorder,
  selector = "[data-wb-rail-sort-id]",
  // Optional drop-into targets (folders): `canDropInto(source, target)` and
  // `onDropInto({ sourceId, targetId })`.
  canDropInto = null,
  onDropInto = null,
}) {
  const phase = ref("idle");
  const draggingId = ref("");
  const offset = ref(0);
  const sourceIndex = ref(-1);
  const targetIndex = ref(-1);
  const intoId = ref("");

  let slots = [];
  let pointerId = null;
  let startY = 0;
  let captureTarget = null;
  let suppressClick = false;
  let settleTimer = 0;

  function measureSlots() {
    const root = container.value;
    if (!root) return [];
    const nodes = new Map([...root.querySelectorAll(selector)].map((node) => [node.dataset.wbRailSortId, node]));
    return items.value.map((item) => {
      const rect = nodes.get(item.id)?.getBoundingClientRect?.();
      return rect ? { top: rect.top, height: rect.height } : null;
    });
  }

  function addListeners() {
    globalThis.addEventListener?.("pointermove", handlePointerMove);
    globalThis.addEventListener?.("pointerup", handlePointerUp);
    globalThis.addEventListener?.("pointercancel", handlePointerCancel);
    globalThis.addEventListener?.("keydown", handleKeydown, true);
  }

  function removeListeners() {
    globalThis.removeEventListener?.("pointermove", handlePointerMove);
    globalThis.removeEventListener?.("pointerup", handlePointerUp);
    globalThis.removeEventListener?.("pointercancel", handlePointerCancel);
    globalThis.removeEventListener?.("keydown", handleKeydown, true);
  }

  function releaseCapture() {
    try {
      if (captureTarget && pointerId !== null) captureTarget.releasePointerCapture?.(pointerId);
    } catch {
      /* capture already released */
    }
    captureTarget = null;
  }

  function reset() {
    removeListeners();
    releaseCapture();
    clearTimeout(settleTimer);
    pointerId = null;
    slots = [];
    draggingId.value = "";
    offset.value = 0;
    sourceIndex.value = -1;
    targetIndex.value = -1;
    intoId.value = "";
  }

  function onPointerDown(item, event) {
    if (phase.value !== "idle" || event.button !== 0 || event.isPrimary === false) return;
    pointerId = event.pointerId;
    startY = event.clientY;
    captureTarget = event.currentTarget || null;
    draggingId.value = item.id;
    phase.value = "pending";
    addListeners();
  }

  function beginDrag(event) {
    slots = measureSlots();
    const index = items.value.findIndex((item) => item.id === draggingId.value);
    if (index < 0 || slots.some((slot) => !slot)) {
      phase.value = "idle";
      reset();
      return false;
    }
    sourceIndex.value = index;
    targetIndex.value = index;
    phase.value = "dragging";
    try {
      captureTarget?.setPointerCapture?.(event.pointerId);
    } catch {
      captureTarget = null;
    }
    return true;
  }

  function handlePointerMove(event) {
    if (event.pointerId !== pointerId) return;
    const delta = event.clientY - startY;
    if (phase.value === "pending") {
      if (Math.abs(delta) < RAIL_SORT_THRESHOLD || !beginDrag(event)) return;
    }
    if (phase.value !== "dragging") return;
    event.preventDefault?.();
    offset.value = clampRailSortOffset(slots, sourceIndex.value, delta);
    const source = items.value[sourceIndex.value];
    const into = canDropInto
      ? railSortIntoIndex(slots, sourceIndex.value, offset.value, (index) => canDropInto(source, items.value[index]))
      : -1;
    // Held over a folder, the others stay put; otherwise a gap opens.
    intoId.value = into >= 0 ? items.value[into].id : "";
    targetIndex.value = into >= 0 ? sourceIndex.value : railSortTargetIndex(slots, sourceIndex.value, offset.value);
  }

  function handlePointerUp(event) {
    if (event.pointerId !== pointerId) return;
    if (phase.value === "pending") {
      phase.value = "idle";
      reset();
      return;
    }
    if (phase.value !== "dragging") return;
    // The click that follows this pointerup must not open the entry. It is
    // dispatched in the same task, so a zero timeout clears the guard even if
    // no click arrives (pointer released off the button).
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    settle(true);
  }

  function handlePointerCancel(event) {
    if (event.pointerId !== pointerId) return;
    if (phase.value === "dragging") settle(false);
    else {
      phase.value = "idle";
      reset();
    }
  }

  function handleKeydown(event) {
    if (event.key !== "Escape" || phase.value === "idle") return;
    event.preventDefault();
    event.stopPropagation();
    if (phase.value === "dragging") settle(false);
    else if (phase.value === "pending") {
      phase.value = "idle";
      reset();
    }
  }

  function settle(commit) {
    removeListeners();
    releaseCapture();
    const source = sourceIndex.value;
    const dropIntoId = commit ? intoId.value : "";
    intoId.value = dropIntoId;
    const intoIndex = dropIntoId ? items.value.findIndex((item) => item.id === dropIntoId) : -1;
    const target = commit ? targetIndex.value : source;
    targetIndex.value = target;
    const landing = intoIndex >= 0 ? intoIndex : target;
    offset.value = slots[landing] && slots[source] ? slots[landing].top - slots[source].top : 0;
    phase.value = "settling";
    const finish = () => {
      const sourceId = draggingId.value;
      const targetId = items.value[target]?.id;
      phase.value = "resetting";
      if (dropIntoId) {
        onDropInto?.({ sourceId, targetId: dropIntoId });
      } else if (commit && targetId && target !== source) {
        onReorder?.({ sourceId, targetId, position: target > source ? "after" : "before" });
      }
      reset();
      nextTick(() => nextFrame(() => {
        if (phase.value === "resetting") phase.value = "idle";
      }));
    };
    if (prefersReducedMotion()) finish();
    else settleTimer = setTimeout(finish, RAIL_SORT_SETTLE_MS);
  }

  function consumeClick() {
    if (!suppressClick && phase.value !== "settling") return false;
    suppressClick = false;
    return true;
  }

  function shiftFor(item, index) {
    if (phase.value !== "dragging" && phase.value !== "settling") return 0;
    if (index === sourceIndex.value) return offset.value;
    return railSortSiblingShift(slots, sourceIndex.value, targetIndex.value, index);
  }

  function isLifted(item) {
    return phase.value === "dragging" && item.id === draggingId.value;
  }

  function isSettling(item) {
    return phase.value === "settling" && item.id === draggingId.value;
  }

  // Alt+Arrow moves the focused entry one slot; focus follows it because the
  // keyed button is re-inserted into the DOM.
  function moveByKeyboard(item, direction) {
    if (phase.value !== "idle") return;
    const index = items.value.findIndex((entry) => entry.id === item.id);
    const neighbor = items.value[index + direction];
    if (index < 0 || !neighbor) return;
    onReorder?.({ sourceId: item.id, targetId: neighbor.id, position: direction > 0 ? "after" : "before" });
    nextTick(() => {
      const node = [...(container.value?.querySelectorAll?.(selector) || [])]
        .find((el) => el.dataset.wbRailSortId === item.id);
      node?.focus?.();
    });
  }

  function dispose() {
    phase.value = "idle";
    reset();
  }

  // The folder the lifted entry is held over, until the drop lands in it.
  function isDropInto(item) {
    return (phase.value === "dragging" || phase.value === "settling") && Boolean(intoId.value) && item.id === intoId.value;
  }

  function isSettlingInto(item) {
    return phase.value === "settling" && Boolean(intoId.value) && item.id === draggingId.value;
  }

  return {
    phase,
    draggingId,
    intoId,
    isDropInto,
    isSettlingInto,
    onPointerDown,
    consumeClick,
    shiftFor,
    isLifted,
    isSettling,
    moveByKeyboard,
    dispose,
  };
}
