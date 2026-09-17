import { onBeforeUnmount, onMounted, ref } from "vue";

function isModifierKey(key) {
  return key === "Control" || key === "Meta";
}

function modifierHeld(event) {
  return Boolean(event?.ctrlKey || event?.metaKey);
}

export function createTabShortcutHintController({
  target = globalThis.window,
  documentTarget = globalThis.document,
} = {}) {
  const hintsVisible = ref(false);

  function hide() {
    hintsVisible.value = false;
  }

  function onKeydown(event) {
    hintsVisible.value = modifierHeld(event);
  }

  function onKeyup(event) {
    if (isModifierKey(event?.key) || !modifierHeld(event)) {
      hide();
      return;
    }
    hintsVisible.value = true;
  }

  function onBlur() {
    hide();
  }

  function onVisibilityChange() {
    if (documentTarget?.hidden) hide();
  }

  function bind() {
    target?.addEventListener?.("keydown", onKeydown, true);
    target?.addEventListener?.("keyup", onKeyup, true);
    target?.addEventListener?.("blur", onBlur);
    documentTarget?.addEventListener?.("visibilitychange", onVisibilityChange);
  }

  function unbind() {
    target?.removeEventListener?.("keydown", onKeydown, true);
    target?.removeEventListener?.("keyup", onKeyup, true);
    target?.removeEventListener?.("blur", onBlur);
    documentTarget?.removeEventListener?.("visibilitychange", onVisibilityChange);
    hide();
  }

  return { hintsVisible, bind, unbind, hide };
}

export function useTabShortcutHints(options) {
  const controller = createTabShortcutHintController(options);
  onMounted(controller.bind);
  onBeforeUnmount(controller.unbind);
  return controller;
}
