// Chinese IME composition is tied to the focused editable element. A grid
// key handler that preventDefault()s the first pinyin letter commits that
// letter and cancels the composition session.

export function isImeKeyEvent(event) {
  if (!event) return false;
  const keyCode = event.keyCode ?? event.which;
  return event.isComposing === true
    || event.key === "Process"
    || event.key === "Unidentified"
    || keyCode === 229;
}

export function markCompositionStart(event) {
  if (!event?.target) return;
  event.target._composing = true;
  // The key that opened composition may already have updated the draft.
  // Keep the DOM under the IME until compositionend.
  event.target._imeLive = true;
}

export function markCompositionEnd(event) {
  if (!event?.target) return;
  event.target._composing = false;
  event.target._imeLive = false;
}

export function shouldCommitEditorInput(event) {
  return !event?.isComposing && !event?.target?._composing;
}

export function cellEditorKeydown(event, handlers = {}) {
  if (!event || isImeKeyEvent(event)) return false;
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    handlers.onEnter?.();
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    handlers.onEscape?.();
    return true;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    handlers.onTab?.(Boolean(event.shiftKey));
    return true;
  }
  return false;
}

function writeImeValue(element, value) {
  if (!element || element._composing || element._imeLive) return;
  const next = value == null ? "" : String(value);
  if (element.value !== next) element.value = next;
}

// Controlled `:value` updates reset an in-progress composition even when the
// string is unchanged. Skip the write while the IME or a direct-type session
// owns the element.
export const vImeValue = {
  mounted(element, binding) {
    writeImeValue(element, binding.value);
  },
  updated(element, binding) {
    writeImeValue(element, binding.value);
  },
};

export function createCellEditorHandlers(emit) {
  return {
    onCellEditorInput(event) {
      if (!shouldCommitEditorInput(event)) return;
      if (event.target) event.target._imeLive = false;
      emit("edit-input", event.target?.value ?? "");
    },
    onCellEditorCompositionStart(event) {
      markCompositionStart(event);
    },
    onCellEditorCompositionEnd(event) {
      markCompositionEnd(event);
      const value = event.target?.value ?? "";
      if (value) emit("edit-input", value);
    },
    onCellEditorKeydown(event) {
      cellEditorKeydown(event, {
        onEnter: () => emit("finish-edit"),
        onEscape: () => emit("cancel-edit"),
        onTab: (shiftKey) => emit("tab-edit", shiftKey),
      });
    },
  };
}
