import { reactive, readonly } from "vue";
import { t } from "../i18n/index.js";
import { detectDesktopPlatform, isMacOSPlatform } from "../utils/desktopPlatform.js";
import { noteShortcutKeydownMatch } from "../utils/menuShortcutDedup.js";

const STORAGE_KEY = "dbscout-shortcut-bindings";
// Set once the macOS default-migration has run, so the Windows-era defaults
// stored by existing installs are rewritten exactly once.
const MACOS_MIGRATION_KEY = "dbscout-shortcut-bindings-mac-v1";

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
  editTableComment: "F3",
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

// macOS-only overrides: the Windows defaults collide with system shortcuts
// there (Ctrl+Q = ⌘Q quits, Ctrl+H = ⌘H hides, Ctrl+Tab = ⌘Tab switches apps).
// "Cmd" and "Ctrl" are interchangeable in this table — matching treats them
// as the same modifier.
export const MACOS_DEFAULT_BINDINGS = Object.freeze({
  replaceInTable: "Cmd+Alt+F",
  openSqlQuery: "Cmd+T",
  nextTab: "Cmd+Shift+]",
  previousTab: "Cmd+Shift+[",
});

/**
 * The default binding set for a platform ("macos" | "windows" | …), so the
 * settings dialog's reset and the first-run defaults follow Mac conventions
 * on macOS while Windows keeps DEFAULT_BINDINGS unchanged.
 */
export function defaultBindingsFor(platform = detectDesktopPlatform()) {
  return platform === "macos"
    ? { ...DEFAULT_BINDINGS, ...MACOS_DEFAULT_BINDINGS }
    : { ...DEFAULT_BINDINGS };
}

// Simplified Chinese action names for messages still authored in Chinese;
// interface labels come from `shortcutLabel`.
export const SHORTCUT_LABELS = Object.freeze({
  openWindow: "打开主窗口",
  pinWindow: "钉住窗口",
  searchDatabase: "搜索数据库",
  searchTable: "查找",
  replaceInTable: "替换",
  openDesign: "打开表设计",
  editTableComment: "修改表备注（首页）",
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
  editTableComment: "shortcut.editTableComment",
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

export function shortcutParts(value) {
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

// Physical key derived from KeyboardEvent.code. With Option or Shift held,
// macOS reports event.key as the translated character ("ƒ", "}"), so combos
// must also match on the layout-independent code.
const CODE_TO_KEY = Object.freeze({
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  Slash: "/",
  Space: "space",
  Tab: "tab",
  Enter: "enter",
  Escape: "escape",
});

export function shortcutKeyFromCode(code) {
  const raw = String(code || "");
  if (/^Key[A-Z]$/.test(raw)) return raw.slice(3).toLowerCase();
  if (/^Digit\d$/.test(raw)) return raw.slice(5);
  if (/^Numpad\d$/.test(raw)) return raw.slice(6);
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(raw)) return raw.toLowerCase();
  return CODE_TO_KEY[raw] || "";
}

export function shortcutComboFromEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  else if (event.metaKey) parts.push("Cmd");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  const rawKey = String(event.key || "");
  if (["Control", "Meta", "Shift", "Alt"].includes(rawKey)) return null;
  let key = rawKey === " " ? "Space" : rawKey.trim();
  // Option turns event.key into "ƒ"-style characters on macOS; record the
  // physical key so the stored combo stays readable and re-matchable.
  if (event.altKey && isMacOSPlatform()) {
    key = shortcutKeyFromCode(event.code) || key;
  }
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
  if (eventKey !== parsed.key) {
    const modifierHeld = Boolean(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey);
    // Fall back to the physical key (event.code) when a modifier rewrites
    // event.key — mainly Option/Shift on macOS.
    if (!modifierHeld || shortcutKeyFromCode(event.code) !== parsed.key) return false;
  }
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

function persistBindings(changes) {
  // Other open windows may have changed bindings since this page loaded.
  const saved = { ...loadStoredBindings(), ...changes };
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(saved));
  return saved;
}

/**
 * One-time migration for existing macOS installs: bindings persisted under
 * the old Windows-era defaults (Ctrl+Q hijacks ⌘Q, Ctrl+H hijacks ⌘H, …) are
 * rewritten to the macOS defaults. A stored combo counts as "old default" via
 * sameShortcutCombo; if the new macOS combo is already claimed by another
 * action the action keeps its stored binding. Returns the migrated map and
 * whether anything changed.
 */
export function migrateMacosDefaultBindings(bindings = {}) {
  const next = { ...bindings };
  let changed = false;
  for (const [action, combo] of Object.entries(MACOS_DEFAULT_BINDINGS)) {
    if (!sameShortcutCombo(next[action], DEFAULT_BINDINGS[action])) continue;
    const taken = Object.keys(next).some(
      (other) => other !== action && sameShortcutCombo(next[other], combo),
    );
    if (taken) continue;
    next[action] = combo;
    changed = true;
  }
  return { bindings: next, changed };
}

function readMigrationFlag() {
  try {
    return globalThis.localStorage?.getItem(MACOS_MIGRATION_KEY) === "1";
  } catch {
    return true;
  }
}

function writeMigrationFlag() {
  try {
    globalThis.localStorage?.setItem(MACOS_MIGRATION_KEY, "1");
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
    const merged = { ...defaultBindingsFor(), ...(stored || {}) };
    if (isMacOSPlatform() && !readMigrationFlag()) {
      const migrated = migrateMacosDefaultBindings(merged);
      try {
        if (migrated.changed) persistBindings(migrated.bindings);
        writeMigrationFlag();
      } catch {
        // Still use the migrated shortcuts for this session if storage is unavailable.
      }
      sharedBindings = reactive(migrated.bindings);
    } else {
      sharedBindings = reactive(merged);
    }
  }
  return sharedBindings;
}

/**
 * Access the shared shortcut bindings. All callers observe the same reactive
 * state (singleton). Pass `invokeWorkbench` so global actions can be
 * re-registered through the Rust backend; the last non-null invoke is kept.
 *
 * `rebind(action, combo)` persists the changed binding and updates the shared
 * state. Global bindings must also register successfully with the OS. Pass an
 * empty combo to clear a binding.
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
    const matched = matchesShortcutCombo(get(action), event);
    // Let the native menu de-dup an action whose accelerator keystroke was
    // already consumed by an in-page keydown handler.
    if (matched) noteShortcutKeydownMatch(action);
    return matched;
  }

  async function registerGlobal(combo) {
    if (!sharedInvoke) return;
    if (combo) {
      await sharedInvoke("register_global_shortcut", { binding: combo });
    } else {
      await sharedInvoke("unregister_global_shortcut");
    }
  }

  async function applyBindings(changes) {
    const changesGlobal = Object.hasOwn(changes, "openWindow");
    const previousGlobal = changesGlobal ? savedGlobalBinding() : "";
    try {
      if (changesGlobal) await registerGlobal(changes.openWindow);
      Object.assign(bindings, persistBindings(changes));
    } catch (error) {
      // Registering a global shortcut can clear the previous OS registration.
      if (changesGlobal) await registerGlobal(previousGlobal).catch(() => {});
      throw error;
    }
  }

  async function rebind(action, combo) {
    await applyBindings({ [action]: normalizeCombo(combo) });
  }

  async function reset() {
    try {
      await applyBindings(defaultBindingsFor());
    } catch (error) {
      throw new Error(`恢复默认快捷键失败：${String(error?.message || error)}`);
    }
  }

  function savedGlobalBinding() {
    return normalizeCombo(loadStoredBindings()?.openWindow ?? bindings.openWindow);
  }

  function restoreGlobalBinding() {
    return registerGlobal(savedGlobalBinding());
  }

  return { bindings: readonly(bindings), all, get, matchesBinding, rebind, reset, restoreGlobalBinding };
}

// Test-only helper: drops the shared singleton so each test starts clean.
export function _resetSingletonForTests() {
  sharedBindings = null;
  sharedInvoke = null;
}
