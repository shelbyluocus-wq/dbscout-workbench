import { onBeforeUnmount, onMounted, ref } from "vue";

const STORAGE_KEY = "dbscout_cell_highlight_color";

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
 * The color is written to the `--wb-cell-highlight` CSS variable on the
 * document root so the grid highlight (#2) picks it up live.
 *
 * @param {object} options
 * @param {Storage} [options.storage] - localStorage by default.
 * @param {HTMLElement} [options.root] - document.documentElement by default.
 */
export function useCellHighlight({ storage = globalThis.localStorage, root = globalThis.document?.documentElement } = {}) {
  const color = ref(readStored(storage));

  function apply(value) {
    if (root?.style?.setProperty) {
      if (value) root.style.setProperty("--wb-cell-highlight", value);
      else root.style.removeProperty("--wb-cell-highlight");
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

  onMounted(() => apply(color.value));
  onBeforeUnmount(() => {});

  return { color, setColor, clear };
}
