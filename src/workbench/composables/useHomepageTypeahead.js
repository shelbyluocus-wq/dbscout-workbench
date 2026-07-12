import { computed, ref } from "vue";
import { findBestTableSearchMatch } from "../utils/tableSearch.js";

const DEFAULT_DISMISS_DELAY = 1200;

function sourceArray(value) {
  const list = Array.isArray(value?.value) ? value.value : value;
  return Array.isArray(list) ? list : [];
}

function tableNameOf(table) {
  return String(table?.tableName || table?.table_name || table?.name || "").trim();
}

export function findHomepageTypeaheadMatch(tables, query) {
  return findBestTableSearchMatch(sourceArray(tables), query, { includeComments: false });
}

export function isHomepageTypeaheadKey(event = {}, active = false) {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
  const key = String(event.key || "");
  if (active && ["Backspace", "Enter", "Escape"].includes(key)) return true;
  return key.length === 1 && (active || key.trim().length > 0);
}

export function createHomepageTypeahead({
  tables = [],
  onMatch = () => {},
  onOpen = () => {},
  dismissDelay = DEFAULT_DISMISS_DELAY,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  const query = ref("");
  const match = ref(null);
  let dismissTimer = null;

  const active = computed(() => query.value.length > 0);
  const matchedTableName = computed(() => tableNameOf(match.value));

  function clearDismissTimer() {
    if (dismissTimer === null) return;
    clearTimeoutFn?.(dismissTimer);
    dismissTimer = null;
  }

  function dismiss() {
    clearDismissTimer();
    query.value = "";
    match.value = null;
  }

  function scheduleDismiss() {
    clearDismissTimer();
    dismissTimer = setTimeoutFn?.(() => {
      dismissTimer = null;
      query.value = "";
      match.value = null;
    }, dismissDelay) ?? null;
  }

  function updateMatch() {
    match.value = findHomepageTypeaheadMatch(tables, query.value);
    if (match.value) onMatch(match.value);
  }

  function handleKeydown(event) {
    if (!isHomepageTypeaheadKey(event, active.value)) return false;
    const key = String(event.key || "");
    event.preventDefault?.();

    if (key === "Escape") {
      dismiss();
      return true;
    }
    if (key === "Enter") {
      if (match.value) onOpen(match.value);
      dismiss();
      return true;
    }
    if (key === "Backspace") query.value = query.value.slice(0, -1);
    else query.value += key;

    if (!query.value) {
      dismiss();
      return true;
    }
    updateMatch();
    scheduleDismiss();
    return true;
  }

  return {
    query,
    match,
    active,
    matchedTableName,
    handleKeydown,
    dismiss,
  };
}
