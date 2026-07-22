import { reactive, readonly } from "vue";

const STORAGE_KEY = "dbscout-shortcut-bindings";

// Default shortcut bindings. Only `openWindow` is a true OS-level global
// shortcut (registered in Rust); the others are in-app keyboard shortcuts
// listed for discoverability and (where reasonable) rebinding. The in-app
// ones are consumed by the existing keydown handlers which read from this
// table via `matchesBinding`.
export const DEFAULT_BINDINGS = Object.freeze({
  openWindow: "Alt+Shift+F",
  searchDatabase: "Ctrl+P",
  searchTable: "Ctrl+F",
  replaceInTable: "Ctrl+H",
  openDesign: "Ctrl+D",
  openSqlQuery: "Ctrl+Q",
  closeTab: "Ctrl+W",
  nextTab: "Ctrl+Tab",
  previousTab: "Ctrl+Shift+Tab",
  undo: "Ctrl+Z",
  save: "Ctrl+S",
});

export const SHORTCUT_LABELS = Object.freeze({
  openWindow: "打开主窗口",
  searchDatabase: "搜索数据库",
  searchTable: "查找",
  replaceInTable: "替换",
  openDesign: "打开表设计",
  openSqlQuery: "新建 SQL 查询",
  closeTab: "关闭当前表",
  nextTab: "下一个表",
  previousTab: "上一个表",
  undo: "撤销",
  save: "保存",
});

// Actions that are global (OS-level) and therefore routed through the Rust
// register_global_shortcut command when rebound.
export const GLOBAL_ACTIONS = new Set(["openWindow"]);

function normalizeCombo(value) {
  return String(value || "").trim();
}

function loadStoredBindings() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistBindings(values) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // best-effort persistence
  }
}

// ── Shared singleton state ──────────────────────────────────────────────
// A single reactive bindings object is shared across every `useShortcuts()`
// caller so the orchestrator's keydown handler and the settings dialog read
// the exact same state. Previously each caller created its own reactive copy,
// so rebinding in the dialog didn't affect the live keydown handler until a
// reload (analysis point #1). The singleton is lazily created on first use.
let sharedBindings = null;
let sharedInvoke = null;

function ensureSharedBindings() {
  if (!sharedBindings) {
    const stored = loadStoredBindings();
    sharedBindings = reactive({ ...DEFAULT_BINDINGS, ...(stored || {}) });
  }
  return sharedBindings;
}

/**
 * Access the shared shortcut bindings. All callers observe the same reactive
 * state (singleton). Pass `invokeWorkbench` so global actions can be
 * re-registered through the Rust backend; the last non-null invoke is kept.
 *
 * `rebind(action, combo)` updates the shared binding, persists it, and — for
 * global actions — re-registers the OS-level shortcut. On backend failure it
 * reverts the in-memory + persisted value and **throws** so the caller (the
 * settings dialog) can surface the error instead of silently showing success
 * (analysis point #3). Pass an empty combo to clear (unregister) a binding.
 *
 * @param {Function} [invokeWorkbench] - The Tauri invoke bridge.
 */
export function useShortcuts(invokeWorkbench) {
  const bindings = ensureSharedBindings();
  if (typeof invokeWorkbench === "function") sharedInvoke = invokeWorkbench;

  function all() {
    return readonly(bindings);
  }

  function get(action) {
    return normalizeCombo(bindings[action]);
  }

  /**
   * Compare a keyboard event against a binding combo. Combos are written as
   * "Modifier+Key" (e.g. "Ctrl+P", "Shift+F"). Comparison is case-insensitive
   * on the key and supports Ctrl/Cmd interchangeably.
   */
  function matchesBinding(action, event) {
    const combo = get(action);
    if (!combo) return false;
    const parts = combo.toLowerCase().split("+").map((part) => part.trim());
    const key = parts.pop();
    if (!key) return false;
    const eventKey = String(event.key || "").toLowerCase();
    if (eventKey !== key) return false;
    const wantCtrl = parts.includes("ctrl") || parts.includes("cmd");
    const wantShift = parts.includes("shift");
    const wantAlt = parts.includes("alt");
    const hasCtrl = event.ctrlKey || event.metaKey;
    if (wantCtrl !== hasCtrl) return false;
    if (wantShift !== event.shiftKey) return false;
    if (wantAlt !== event.altKey) return false;
    return true;
  }

  async function registerGlobal(combo) {
    if (!sharedInvoke) return;
    if (combo) {
      await sharedInvoke("register_global_shortcut", { binding: combo });
    } else {
      await sharedInvoke("unregister_global_shortcut");
    }
  }

  async function rebind(action, combo) {
    const next = normalizeCombo(combo);
    const previous = bindings[action] ?? "";
    if (previous === next) return;
    bindings[action] = next;
    persistBindings(bindings);
    if (GLOBAL_ACTIONS.has(action)) {
      try {
        await registerGlobal(next);
      } catch (error) {
        // Revert both state and storage so the UI reflects reality and the
        // user isn't left with a binding that doesn't actually work (#3).
        bindings[action] = previous;
        persistBindings(bindings);
        throw error;
      }
    }
  }

  async function reset() {
    // Restore every default binding, then re-register the global shortcut so
    // the backend matches the UI (analysis point #2).
    for (const action of Object.keys(DEFAULT_BINDINGS)) {
      bindings[action] = DEFAULT_BINDINGS[action];
    }
    persistBindings(bindings);
    try {
      await registerGlobal(DEFAULT_BINDINGS.openWindow);
    } catch (error) {
      throw new Error(`恢复默认快捷键失败：${String(error?.message || error)}`);
    }
  }

  return { bindings: readonly(bindings), all, get, matchesBinding, rebind, reset };
}

// Test-only helper: drops the shared singleton so each test starts clean.
export function _resetSingletonForTests() {
  sharedBindings = null;
  sharedInvoke = null;
}
