import { computed, ref } from "vue";
import { ArrowLeftRight, FileSearch, FileSpreadsheet, Plus, Settings, ShieldCheck } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { formatShortcutForPlatform } from "../utils/desktopPlatform.js";
import { previewDragOrder } from "../sidebarDragPreview.js";

const ORDER_STORAGE_KEY = "dbscout_activity_rail_order";

// Entries of the always-visible left rail, top to bottom. `separatorBefore`
// draws the rail divider above an entry; `zone: "bottom"` pins an entry to the
// rail's bottom edge (always last, not reorderable). Every other `id` dispatches
// to the handler of the same name passed to `useActivityRail({ actions })` and
// can be reordered by dragging; the order persists in localStorage.
export const ACTIVITY_RAIL_ENTRIES = Object.freeze([
  Object.freeze({ id: "addConnection", icon: Plus, labelKey: "m_441ba9e5a9b7", popup: "dialog" }),
  Object.freeze({
    id: "quickOpen",
    icon: FileSearch,
    labelKey: "m_13e21519f8b9",
    hintKey: "shell.quickOpenAria",
    shortcutAction: "searchDatabase",
    popup: "dialog",
    separatorBefore: true,
  }),
  Object.freeze({
    id: "databaseFavorites",
    icon: ArrowLeftRight,
    labelKey: "m_b2772946e700",
    hintKey: "shell.databaseFavoritesHint",
    popup: "menu",
  }),
  Object.freeze({
    id: "backupCenter",
    icon: ShieldCheck,
    labelKey: "m_965320c43727",
    hintKey: "shell.backupCenterHint",
    popup: "dialog",
  }),
  Object.freeze({
    id: "tableTransfer",
    icon: FileSpreadsheet,
    labelKey: "m_a36603b169a6",
    hintKey: "shell.tableTransferHint",
    shortcutAction: "openTableTransfer",
    popup: "dialog",
  }),
  Object.freeze({
    id: "settings",
    icon: Settings,
    labelKey: "m_df3d58c7d84b",
    hintKey: "shell.settingsHint",
    popup: "dialog",
    controls: "wb-sidebar-settings-sheet",
    zone: "bottom",
  }),
]);

const TOP_ENTRIES = ACTIVITY_RAIL_ENTRIES.filter((entry) => entry.zone !== "bottom");
const BOTTOM_ENTRIES = ACTIVITY_RAIL_ENTRIES.filter((entry) => entry.zone === "bottom");

function readStoredOrder(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(ORDER_STORAGE_KEY) || "null");
    return Array.isArray(parsed) ? parsed.map((id) => String(id)) : null;
  } catch {
    return null;
  }
}

function writeStoredOrder(ids, storage) {
  try {
    storage?.setItem?.(ORDER_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

// Merge a persisted id list with the built-in defaults: drop unknown ids (entry
// removed from the app) and re-insert missing ids at their default position so
// newly shipped entries still land where the design expects.
export function resolveActivityRailOrder(stored) {
  const defaultIds = TOP_ENTRIES.map((entry) => entry.id);
  const known = new Set(defaultIds);
  const ordered = (Array.isArray(stored) ? stored : []).filter((id) => known.has(String(id)));
  defaultIds.forEach((id, index) => {
    if (!ordered.includes(id)) ordered.splice(Math.min(index, ordered.length), 0, id);
  });
  return ordered;
}

// aria-keyshortcuts expects KeyboardEvent.key modifier names, not the
// abbreviations shown on screen.
const ARIA_MODIFIER_NAMES = Object.freeze({
  ctrl: "Control",
  control: "Control",
  cmd: "Meta",
  command: "Meta",
  alt: "Alt",
  shift: "Shift",
});

function toAriaKeyShortcut(label) {
  return String(label || "")
    .split("+")
    .filter(Boolean)
    .map((part) => ARIA_MODIFIER_NAMES[part.toLowerCase()] || part)
    .join("+");
}

function storageOrDefault(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function useActivityRail({ actions = {}, shortcuts = null, translate = t, expanded = {}, storage = null } = {}) {
  const localStorage_ = storageOrDefault(storage);
  const customOrder = ref(readStoredOrder(localStorage_));

  const orderedIds = computed(() => resolveActivityRailOrder(customOrder.value));
  const entryById = new Map(ACTIVITY_RAIL_ENTRIES.map((entry) => [entry.id, entry]));

  function toItem(entry) {
    const shortcut = entry.shortcutAction ? shortcuts?.get(entry.shortcutAction) || "" : "";
    const shortcutLabel = formatShortcutForPlatform(shortcut);
    const expandedValue = expanded[entry.id];
    return {
      id: entry.id,
      icon: entry.icon,
      label: translate(entry.labelKey),
      hint: entry.hintKey ? translate(entry.hintKey) : "",
      popup: entry.popup || "",
      controls: entry.controls || "",
      expanded: expandedValue === undefined ? undefined : Boolean(typeof expandedValue === "function" ? expandedValue() : expandedValue),
      separatorBefore: entry.separatorBefore === true,
      shortcutLabel,
      ariaShortcut: toAriaKeyShortcut(shortcutLabel),
    };
  }

  const items = computed(() => orderedIds.value.map((id) => toItem(entryById.get(id))));
  const bottomItems = computed(() => BOTTOM_ENTRIES.map(toItem));

  function reorder(sourceId, targetId, { position = "before" } = {}) {
    const next = previewDragOrder(orderedIds.value, sourceId, targetId, { position });
    if (next.join("\u001f") === orderedIds.value.join("\u001f")) return;
    customOrder.value = next;
    writeStoredOrder(next, localStorage_);
  }

  function select(id, ...args) {
    const action = actions[id];
    if (typeof action === "function") action(...args);
  }

  return { items, bottomItems, select, reorder };
}
