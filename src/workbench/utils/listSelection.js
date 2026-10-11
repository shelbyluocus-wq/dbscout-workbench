import { isMacOSPlatform } from "./desktopPlatform.js";
import { homeEnterOpenNames } from "./homeEnterOpen.js";

// Shared multi-selection rules for table lists (database home and sidebar).
// They follow desktop file-manager conventions so every list behaves alike:
// a click selects one item, Ctrl/Cmd+click toggles one, Shift+click selects
// the range from the anchor, and Ctrl/Cmd+Shift+click adds that range.

// Opening this many tables at once asks first, as Explorer does for files.
export const OPEN_MANY_TABLES_THRESHOLD = 15;

function hasCommandModifier(event) {
  return Boolean(event?.ctrlKey || event?.metaKey);
}

function uniqueNames(names) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(names) ? names : []) {
    const name = String(value ?? "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

export function isPlainSelectionEvent(event = {}) {
  return !event?.shiftKey && !hasCommandModifier(event) && !event?.altKey;
}

/**
 * Applies one pointer or keyboard selection gesture.
 *
 * @param {{ order?: string[], selected?: string[], anchor?: string, name?: string, event?: object }} input
 * @returns {{ selected: string[], anchor: string }}
 */
export function nextListSelection({ order = [], selected = [], anchor = "", name = "", event = {} } = {}) {
  const target = String(name ?? "");
  const current = uniqueNames(selected);
  if (!target) return { selected: current, anchor };
  const additive = hasCommandModifier(event);
  if (event?.shiftKey && anchor) {
    const list = Array.isArray(order) ? order : [];
    const from = list.indexOf(anchor);
    const to = list.indexOf(target);
    if (from >= 0 && to >= 0) {
      const range = list.slice(Math.min(from, to), Math.max(from, to) + 1);
      // The anchor stays put so successive Shift gestures pivot around it.
      return { selected: additive ? uniqueNames([...current, ...range]) : range, anchor };
    }
  }
  if (additive) {
    return {
      selected: current.includes(target) ? current.filter((item) => item !== target) : [...current, target],
      anchor: target,
    };
  }
  return { selected: [target], anchor: target };
}

/**
 * A plain click collapses a multi-selection before the browser reports the
 * double-click. Remember what it replaced so the double-click can act on the
 * whole selection, as Explorer and Finder do.
 */
export function createSelectionRecall({ now = () => Date.now(), windowMs = 1500 } = {}) {
  let memory = null;

  function remember(name, selected) {
    const names = uniqueNames(selected);
    const target = String(name ?? "");
    memory = target && names.length > 1 && names.includes(target)
      ? { name: target, names, at: now() }
      : null;
  }

  function recall(name) {
    const entry = memory;
    memory = null;
    if (!entry || entry.name !== String(name ?? "") || now() - entry.at > windowMs) return null;
    return entry.names;
  }

  function clear() {
    memory = null;
  }

  return { remember, recall, clear };
}

/**
 * Which tables an open gesture (Enter, double-click, menu) covers. A row inside
 * the selection opens the whole selection in list order; the row the user
 * acted on becomes the active tab and the others open in the background.
 */
export function selectionOpenPlan(focusedName = "", selectedNames = [], order = []) {
  const names = homeEnterOpenNames(focusedName, selectedNames);
  const position = new Map((Array.isArray(order) ? order : []).map((name, index) => [String(name), index]));
  const ordered = names
    .map((name, index) => ({ name, index, rank: position.has(name) ? position.get(name) : Number.MAX_SAFE_INTEGER }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.name);
  const focused = String(focusedName ?? "");
  return { names: ordered, activeName: ordered.includes(focused) ? focused : ordered.at(-1) || "" };
}

/**
 * Asks before opening more than OPEN_MANY_TABLES_THRESHOLD tables at once so a
 * stray Ctrl+A and Enter cannot flood the workbench with tabs.
 *
 * @param {number} count
 * @param {{ confirm: Function, t: Function }} ui the confirm dialog and translator
 */
export function confirmOpeningTables(count, { confirm, t }) {
  if (!(count > OPEN_MANY_TABLES_THRESHOLD)) return Promise.resolve(true);
  return confirm({
    title: t("home.openManyTitle", { count }),
    message: t("home.openManyMessage", { count }),
    confirmText: t("home.openTables", { count }),
    cancelText: t("m_2cd0f3be8738"),
  });
}

/**
 * Delete removes the selection. On macOS the Backspace key is labelled
 * "delete", so it counts there too (with or without Command, as in Finder).
 */
export function isDeleteCommandKey(event = {}, { mac = isMacOSPlatform() } = {}) {
  if (event?.altKey || event?.shiftKey || event?.ctrlKey) return false;
  const key = String(event?.key || "");
  if (key === "Delete") return !event?.metaKey;
  return mac && key === "Backspace";
}

// Shift+F10 and the Menu key open the context menu for the keyboard focus.
export function isContextMenuKey(event = {}) {
  const key = String(event?.key || "");
  if (key === "ContextMenu") return true;
  return key === "F10" && Boolean(event?.shiftKey) && !hasCommandModifier(event) && !event?.altKey;
}
