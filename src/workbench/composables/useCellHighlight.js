import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const STORAGE_KEY = "dbscout_cell_highlight_color";
const LIGHT_STORAGE_KEY = `${STORAGE_KEY}_light`;
const DARK_STORAGE_KEY = `${STORAGE_KEY}_dark`;
const HIGHLIGHT_CUSTOM_TOKEN = "--wb-cell-highlight-custom";

function storageKeyForTheme(theme) {
  return theme === "dark" ? DARK_STORAGE_KEY : LIGHT_STORAGE_KEY;
}

function normalizeTheme(theme) {
  return theme === "dark" ? "dark" : "light";
}

function readStored(storage, theme) {
  try {
    const themeKey = storageKeyForTheme(theme);
    const themeValue = storage?.getItem(themeKey);
    if (themeValue) return themeValue;

    const legacyValue = storage?.getItem(STORAGE_KEY) || "";
    if (legacyValue) {
      storage?.setItem(themeKey, legacyValue);
      storage?.removeItem(STORAGE_KEY);
    }
    return legacyValue;
  } catch {
    return "";
  }
}

function writeStored(storage, theme, value) {
  try {
    const key = storageKeyForTheme(theme);
    if (value) storage?.setItem(key, value);
    else storage?.removeItem(key);
  } catch {
    // best-effort persistence
  }
}

/**
 * Persists and applies the user-chosen cell row/column highlight color.
 * The color is written as a root-level override so light and dark theme
 * defaults can both inherit the user's selection.
 *
 * @param {object} options
 * @param {Storage} [options.storage] - localStorage by default.
 * @param {HTMLElement} [options.root] - document.documentElement by default.
 * @param {Function} [options.getTheme] - returns "light" or "dark".
 */
export function createCellHighlightController({
  storage = globalThis.localStorage,
  root = globalThis.document?.documentElement,
  getTheme = () => globalThis.document?.querySelector?.(".mysql-workbench")?.getAttribute?.("data-theme") || globalThis.document?.documentElement?.dataset?.wbTheme || "light",
} = {}) {
  const activeTheme = () => normalizeTheme(getTheme());
  const color = ref(readStored(storage, activeTheme()));

  function apply(value) {
    if (root?.style?.setProperty) {
      if (value) root.style.setProperty(HIGHLIGHT_CUSTOM_TOKEN, value);
      else root.style.removeProperty(HIGHLIGHT_CUSTOM_TOKEN);
    }
  }

  function setColor(value) {
    color.value = value || "";
    writeStored(storage, activeTheme(), color.value);
    apply(color.value);
  }

  function clear() {
    setColor("");
  }

  function syncTheme() {
    color.value = readStored(storage, activeTheme());
    apply(color.value);
  }

  return { color, setColor, clear, apply, syncTheme };
}

export function useCellHighlight(options = {}) {
  const controller = createCellHighlightController(options);

  onMounted(() => controller.syncTheme());
  const stopThemeWatch = options.themeRef
    ? watch(options.themeRef, () => controller.syncTheme())
    : () => {};

  onBeforeUnmount(() => {
    stopThemeWatch();
  });

  return controller;
}
