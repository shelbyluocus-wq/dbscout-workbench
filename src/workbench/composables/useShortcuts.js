import { reactive, readonly } from "vue";
import { t } from "../i18n/index.js";

const STORAGE_KEY = "dbscout-shortcut-bindings";

// Default shortcut bindings. Only `openWindow` is a true OS-level global
// shortcut (registered in Rust); the others are in-app keyboard shortcuts
// listed for discoverability and (where reasonable) rebinding. The in-app
// ones are consumed by the existing keydown handlers which read from this
// table via `matchesBinding`.
export const DEFAULT_BINDINGS = Object.freeze({
  openWindow: "Alt+Shift+F",
  pinWindow: "F8",
  searchDatabase: "Ctrl+P",
  searchTable: "Ctrl+F",
  replaceInTable: "Ctrl+H",
  openDesign: "Ctrl+D",
  openSqlQuery: "Ctrl+Q",
  openTableTransfer: "Ctrl+Shift+T",
  closeTab: "Ctrl+W",
  nextTab: "Ctrl+Tab",
  previousTab: "Ctrl+Shift+Tab",
  undo: "Ctrl+Z",
  save: "Ctrl+S",
  // F5 refreshes the home table list or the current table instead of letting
  // the WebView reload the whole window (and lose unsaved work).
  refresh: "F5",
});

// Simplified Chinese action names for messages still authored in Chinese;
// interface labels come from `shortcutLabel`.
export const SHORTCUT_LABELS = Object.freeze({
  openWindow: "打开主窗口",
  pinWindow: "钉住窗口",
  searchDatabase: "搜索数据库",
  searchTable: "查找",
  replaceInTable: "替换",
  openDesign: "打开表设计",
  openSqlQuery: "新建 SQL 查询",
  openTableTransfer: "一键转表",
  closeTab: "关闭当前表",
  nextTab: "下一个表",
  previousTab: "上一个表",
  undo: "撤销",
  save: "保存",
  refresh: "刷新",
});

const SHORTCUT_LABEL_KEYS = Object.freeze({
  openWindow: "shortcut.openWindow",
  pinWindow: "shortcut.pinWindow",
  searchDatabase: "shortcut.searchDatabase",
  searchTable: "shortcut.searchTable",
  replaceInTable: "shortcut.replaceInTable",
  openDesign: "shortcut.openDesign",
  openSqlQuery: "shortcut.openSqlQuery",
  openTableTransfer: "shortcut.openTableTransfer",
  closeTab: "shortcut.closeTab",
  nextTab: "shortcut.nextTab",
  previousTab: "shortcut.previousTab",
  undo: "shortcut.undo",
  save: "shortcut.save",
  refresh: "shortcut.refresh",
});

export function shortcutLabel(action) {
  const key = SHORTCUT_LABEL_KEYS[action];
  return key ? t(key) : String(action || "");
}

// Actions that are global (OS-level) and therefore routed through the Rust
// register_global_shortcut command when rebound.
export const GLOBAL_ACTIONS = new Set(["openWindow"]);

function normalizeCombo(value) {
  return String(value || "").trim();
}

function shortcutParts(value) {
  const parts = normalizeCombo(value).split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.pop() || "";
  const lowered = parts.map((part) => part.toLowerCase());
  return {
    key: key.toLowerCase(),
    ctrl: lowered.includes("ctrl") || lowered.includes("cmd") || lowered.includes("command"),
    shift: lowered.includes("shift"),
    alt: lowered.includes("alt") || lowered.includes("option"),
  };
}

export function shortcutComboFromEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  else if (event.metaKey) parts.push("Cmd");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  const rawKey = String(event.key || "");
  if (["Control", "Meta", "Shift", "Alt"].includes(rawKey)) return null;
  const key = rawKey === " " ? "Space" : rawKey.trim();
  if (!key) return null;
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join("+");
}

export function matchesShortcutCombo(combo, event) {
  const parsed = shortcutParts(combo);
  if (!parsed.key) return false;
  const eventKey = String(event.key || "").toLowerCase() === " "
    ? "space"
    : String(event.key || "").toLowerCase();
  if (eventKey !== parsed.key) return false;
  const hasCtrl = Boolean(event.ctrlKey || event.metaKey);
  return (
    parsed.ctrl === hasCtrl &&
    parsed.shift === Boolean(event.shiftKey) &&
    parsed.alt === Boolean(event.altKey)
  );
}

export function sameShortcutCombo(left, right) {
  const a = shortcutParts(left);
  const b = shortcutParts(right);
  return Boolean(a.key && b.key) && a.key === b.key && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt;
}

export function isSafeInAppShortcut(combo) {
  const parsed = shortcutParts(combo);
  if (!parsed.key) return false;
  if (parsed.ctrl || parsed.alt) return true;
  return /^f(?:[1-9]|1[0-2])$/i.test(parsed.key);
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
    return matchesShortcutCombo(get(action), event);
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
