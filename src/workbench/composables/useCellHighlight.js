import { onBeforeUnmount, onMounted, ref } from "vue";

const STORAGE_KEY = "dbscout_cell_highlight_color";
const HIGHLIGHT_CUSTOM_TOKEN = "--wb-cell-highlight-custom";

function readStored(storage) {
  try {
    return storage?.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function writeStored(storage, value) {
  try {
    if (value) storage?.setItem(STORAGE_KEY, value);
    else storage?.removeItem(STORAGE_KEY);
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
 */
export function createCellHighlightController({ storage = globalThis.localStorage, root = globalThis.document?.documentElement } = {}) {
  const color = ref(readStored(storage));

  function apply(value) {
    if (root?.style?.setProperty) {
      if (value) root.style.setProperty(HIGHLIGHT_CUSTOM_TOKEN, value);
      else root.style.removeProperty(HIGHLIGHT_CUSTOM_TOKEN);
    }
  }

  function setColor(value) {
    color.value = value || "";
    writeStored(storage, color.value);
    apply(color.value);
  }

  function clear() {
    setColor("");
  }

  return { color, setColor, clear, apply };
}

export function useCellHighlight(options = {}) {
  const controller = createCellHighlightController(options);

  onMounted(() => controller.apply(controller.color.value));
  onBeforeUnmount(() => {});

  return controller;
}
