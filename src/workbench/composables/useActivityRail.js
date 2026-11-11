import { computed, ref } from "vue";
import { ArrowLeftRight, Circle, Ellipsis, FileSpreadsheet, Plus, Rocket, Search, Settings } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { formatShortcutForPlatform, isMacOSPlatform } from "../utils/desktopPlatform.js";
import { previewDragOrder } from "../sidebarDragPreview.js";

const ORDER_STORAGE_KEY = "dbscout_activity_rail_order";

// Entries of the always-visible left rail, top to bottom. `zone: "lead"` pins an
// entry above the rail divider, `zone: "more"` keeps the overflow trigger out of
// the reorderable group (it renders through `moreItem`), and `zone: "bottom"`
// pins an entry to the rail's bottom edge; none of them is reorderable. Entries
// without a zone form the tool group, which can be reordered by dragging (order
// persists in localStorage). Table folders, the backup center, Blackcat MCP and
// the window pin live in the More menu, not here. Every `id` dispatches to the
// handler of the same name passed to `useActivityRail({ actions })`.
export const ACTIVITY_RAIL_ENTRIES = Object.freeze([
  Object.freeze({ id: "addConnection", icon: Plus, labelKey: "m_441ba9e5a9b7", popup: "dialog", zone: "lead" }),
  Object.freeze({
    id: "quickOpen",
    icon: Search,
    labelKey: "m_13e21519f8b9",
    hintKey: "shell.quickOpenAria",
    shortcutAction: "searchDatabase",
    popup: "dialog",
  }),
  Object.freeze({
    id: "databaseFavorites",
    icon: ArrowLeftRight,
    labelKey: "m_b2772946e700",
    hintKey: "shell.databaseFavoritesHint",
    popup: "menu",
  }),
  Object.freeze({
    id: "tableTransfer",
    icon: FileSpreadsheet,
    labelKey: "m_a36603b169a6",
    hintKey: "shell.tableTransferHint",
    shortcutAction: "openTableTransfer",
    popup: "dialog",
  }),
  Object.freeze({ id: "more", icon: Ellipsis, labelKey: "m_38844b135cf7", popup: "menu", controls: "wb-activity-more-menu", zone: "more" }),
  Object.freeze({ id: "update", icon: Circle, labelKey: "updater.title.idle", popup: "dialog", zone: "bottom" }),
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

const LEAD_ENTRIES = ACTIVITY_RAIL_ENTRIES.filter((entry) => entry.zone === "lead");
const TOP_ENTRIES = ACTIVITY_RAIL_ENTRIES.filter((entry) => !entry.zone);
const BOTTOM_ENTRIES = ACTIVITY_RAIL_ENTRIES.filter((entry) => entry.zone === "bottom");

// Shown directly above the updater dot in the bottom zone only while the
// Release workspace is minimized, keeping the default rail untouched.
const RELEASE_FLOW_BOTTOM_ENTRY = Object.freeze({
  id: "releaseFlow",
  icon: Rocket,
  labelKey: "releaseFlow.title",
  hintKey: "releaseFlow.minimized.restoreHint",
  popup: "dialog",
  zone: "bottom",
});

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

// aria-keyshortcuts wants KeyboardEvent.key modifier names on the raw combo —
// not the glyph-formatted display label ("⌘P" would not parse).
function toAriaKeyShortcut(combo) {
  const onMac = isMacOSPlatform();
  return String(combo || "")
    .split("+")
    .filter(Boolean)
    .map((part) => {
      const name = ARIA_MODIFIER_NAMES[part.toLowerCase()];
      // "Ctrl" in a combo means the primary modifier: Meta on macOS.
      if (name === "Control") return onMac ? "Meta" : "Control";
      return name || part;
    })
    .join("+");
}

function storageOrDefault(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function useActivityRail({ actions = {}, shortcuts = null, translate = t, expanded = {}, badges = {}, states = {}, storage = null } = {}) {
  const localStorage_ = storageOrDefault(storage);
  const customOrder = ref(readStoredOrder(localStorage_));

  const orderedIds = computed(() => resolveActivityRailOrder(customOrder.value));
  const entryById = new Map(ACTIVITY_RAIL_ENTRIES.map((entry) => [entry.id, entry]));

  function toItem(entry, stateOverride = states[entry.id]?.()) {
    const shortcut = entry.shortcutAction ? shortcuts?.get(entry.shortcutAction) || "" : "";
    const shortcutLabel = formatShortcutForPlatform(shortcut);
    const expandedValue = expanded[entry.id];
    const badgeSource = badges[entry.id];
    const badge = badgeSource === undefined
      ? 0
      : Math.max(0, Math.floor(Number(typeof badgeSource === "function" ? badgeSource() : badgeSource) || 0));
    return {
      id: entry.id,
      icon: entry.icon,
      label: translate(entry.labelKey),
      hint: entry.hintKey ? translate(entry.hintKey) : "",
      popup: entry.popup || "",
      controls: entry.controls || "",
      expanded: expandedValue === undefined ? undefined : Boolean(typeof expandedValue === "function" ? expandedValue() : expandedValue),
      shortcutLabel,
      ariaShortcut: toAriaKeyShortcut(shortcut),
      badge,
      badgeText: badge > 99 ? "99+" : badge > 0 ? String(badge) : "",
      badgeLabel: badge > 0 ? translate("shell.railBadge", { count: badge }) : "",
      ...(stateOverride || {}),
    };
  }

  const leadItems = computed(() => LEAD_ENTRIES.map((entry) => toItem(entry)));
  const items = computed(() => orderedIds.value.map((id) => toItem(entryById.get(id))));
  const bottomItems = computed(() => {
    const base = BOTTOM_ENTRIES.map((entry) => toItem(entry));
    const releaseState = states.releaseFlow?.();
    if (!releaseState?.visible) return base;
    const { visible: _visible, ...rest } = releaseState;
    return [toItem(RELEASE_FLOW_BOTTOM_ENTRY, rest), ...base];
  });

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

  const moreItem = computed(() => toItem(entryById.get("more")));
  return { leadItems, items, bottomItems, moreItem, select, reorder };
}
