import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const STORAGE_PREFIX = "dbscout_field_comment_color";
const CUSTOM_TOKEN = "--wb-field-comment-custom";
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function normalizeTheme(theme) {
  return theme === "dark" ? "dark" : "light";
}

function storageKey(theme) {
  return `${STORAGE_PREFIX}_${normalizeTheme(theme)}`;
}

function normalizeColor(value) {
  const color = String(value || "").trim();
  return HEX_COLOR_PATTERN.test(color) ? color.toLowerCase() : "";
}

export function createFieldCommentColorController({
  storage = globalThis.localStorage,
  root = globalThis.document?.documentElement,
  getTheme = () => globalThis.document?.documentElement?.dataset?.wbTheme || "light",
} = {}) {
  function read() {
    try {
      return normalizeColor(storage?.getItem(storageKey(getTheme())));
    } catch {
      return "";
    }
  }

  const color = ref(read());

  function apply(value) {
    if (!root?.style) return;
    if (value) root.style.setProperty(CUSTOM_TOKEN, value);
    else root.style.removeProperty(CUSTOM_TOKEN);
  }

  function setColor(value) {
    const normalized = normalizeColor(value);
    color.value = normalized;
    try {
      if (normalized) storage?.setItem(storageKey(getTheme()), normalized);
      else storage?.removeItem(storageKey(getTheme()));
    } catch {
      // Local display preferences are best effort.
    }
    apply(normalized);
  }

  function clear() {
    setColor("");
  }

  function syncTheme() {
    color.value = read();
    apply(color.value);
  }

  return { color, setColor, clear, syncTheme, apply };
}

export function useFieldCommentColor(options = {}) {
  const controller = createFieldCommentColorController(options);
  onMounted(controller.syncTheme);
  const stopThemeWatch = options.themeRef ? watch(options.themeRef, controller.syncTheme) : () => {};
  onBeforeUnmount(stopThemeWatch);
  return controller;
}
