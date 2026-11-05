import { watchEffect } from "vue";

import { t } from "../i18n/index.js";
import { isTauriRuntime } from "../utils/tauriBridge.js";
import { isMacOSPlatform } from "../utils/desktopPlatform.js";
import { isRecentShortcutKeydown } from "../utils/menuShortcutDedup.js";
import { buildNativeAppMenuModel, nativeAppMenuSignature } from "../utils/nativeAppMenuModel.js";

// Thin adapter over @tauri-apps/api/menu. The pure tree comes from
// buildNativeAppMenuModel; this composable creates the Tauri objects once,
// updates enabled/checked/text in place when the state snapshot changes, and
// rebuilds only when the structural signature (language, bindings, item
// layout) changes. No-op outside a native macOS runtime.
export function useNativeAppMenu({
  bindings = {},
  state = () => ({}),
  actions = {},
  translate = t,
  appName = "黑猫",
  appVersion = "",
  enabled = () => isTauriRuntime() && isMacOSPlatform(),
  menuApi = null,
} = {}) {
  const itemById = new Map();
  const lastApplied = new Map();
  let menuModulePromise = null;
  let appMenu = null;
  let windowSubmenu = null;
  let helpSubmenu = null;
  let buildToken = 0;
  let started = false;
  let stopWatcher = null;

  function bindingsSnapshot() {
    const snapshot = {};
    for (const key of Object.keys(bindings || {})) snapshot[key] = bindings[key];
    return snapshot;
  }

  function resolveApi() {
    if (menuApi) return Promise.resolve(menuApi);
    menuModulePromise ||= import("@tauri-apps/api/menu");
    return menuModulePromise;
  }

  function dispatch(entry) {
    // The keystroke may have already been consumed by the in-page handler for
    // the same binding — skip a menu fire that lands within the dedup window.
    if (entry.shortcutAction && isRecentShortcutKeydown(entry.shortcutAction)) return;
    const action = actions[entry.action];
    if (typeof action === "function") void action();
  }

  async function createItem(api, entry) {
    if (entry.kind === "separator") {
      return api.PredefinedMenuItem.new({ item: "Separator" });
    }
    if (entry.kind === "about") {
      return api.PredefinedMenuItem.new({
        text: entry.label,
        item: { About: { name: entry.about?.name, version: entry.about?.version } },
      });
    }
    if (entry.kind === "predefined") {
      return api.PredefinedMenuItem.new({ text: entry.label, item: entry.predefined });
    }
    if (entry.kind === "submenu") {
      const children = [];
      for (const child of entry.items || []) {
        children.push(await createItem(api, child));
        itemById.set(child.id, children[children.length - 1]);
        rememberApplied(child);
      }
      return api.Submenu.new({ text: entry.label, items: children });
    }
    if (entry.kind === "check") {
      return api.CheckMenuItem.new({
        text: entry.label,
        checked: entry.checked === true,
        enabled: entry.enabled !== false,
        accelerator: entry.accelerator || undefined,
        action: () => dispatch(entry),
      });
    }
    return api.MenuItem.new({
      text: entry.label,
      enabled: entry.enabled !== false,
      accelerator: entry.accelerator || undefined,
      action: () => dispatch(entry),
    });
  }

  function rememberApplied(entry) {
    lastApplied.set(entry.id, {
      enabled: entry.enabled !== false,
      checked: entry.checked === true,
      label: entry.label || "",
    });
  }

  function applyModel(model) {
    for (const submenu of model) {
      for (const entry of submenu.items || []) {
        if (entry.kind === "submenu") {
          for (const child of entry.items || []) {
            applyEntry(child);
          }
          continue;
        }
        applyEntry(entry);
      }
    }
  }

  function applyEntry(entry) {
    const target = itemById.get(entry.id);
    const previous = lastApplied.get(entry.id);
    rememberApplied(entry);
    if (!target || !previous) return;
    if ((entry.kind === "item" || entry.kind === "check") && (entry.enabled !== false) !== previous.enabled) {
      void target.setEnabled?.(entry.enabled !== false);
    }
    if (entry.kind === "check" && (entry.checked === true) !== previous.checked) {
      void target.setChecked?.(entry.checked === true);
    }
    if (entry.dynamicLabel && entry.label !== previous.label) {
      void target.setText?.(entry.label);
    }
  }

  async function rebuildMenu(model) {
    const token = ++buildToken;
    const api = await resolveApi();
    itemById.clear();
    lastApplied.clear();
    windowSubmenu = null;
    helpSubmenu = null;
    const submenus = [];
    for (const submenuModel of model) {
      const items = [];
      for (const entry of submenuModel.items || []) {
        const created = await createItem(api, entry);
        items.push(created);
        itemById.set(entry.id, created);
        rememberApplied(entry);
      }
      const submenu = await api.Submenu.new({ text: submenuModel.label, items });
      if (submenuModel.role === "windowMenu") windowSubmenu = submenu;
      if (submenuModel.role === "helpMenu") helpSubmenu = submenu;
      submenus.push(submenu);
    }
    const menu = await api.Menu.new({ items: submenus });
    if (token !== buildToken) return;
    await menu.setAsAppMenu();
    try { await windowSubmenu?.setAsWindowsMenuForNSApp?.(); } catch { /* optional on this runtime */ }
    try { await helpSubmenu?.setAsHelpMenuForNSApp?.(); } catch { /* optional on this runtime */ }
    appMenu = menu;
  }

  function start() {
    if (started || !enabled()) return () => {};
    started = true;
    let signature = null;
    stopWatcher = watchEffect(() => {
      let model;
      try {
        model = buildNativeAppMenuModel({
          t: translate,
          bindings: bindingsSnapshot(),
          state: state() || {},
          options: { appName, appVersion },
        });
      } catch (error) {
        console.error("[useNativeAppMenu] model build failed:", error);
        return;
      }
      const nextSignature = nativeAppMenuSignature(model);
      if (nextSignature !== signature) {
        signature = nextSignature;
        void rebuildMenu(model).catch((error) => {
          // Surface the failure — a silently missing menu is worse than a
          // visible diagnostic (Tauri's default menu stays in place).
          console.error("[useNativeAppMenu] rebuild failed:", error);
        });
      } else {
        try {
          applyModel(model);
        } catch (error) {
          console.error("[useNativeAppMenu] in-place update failed:", error);
        }
      }
    });
    return stop;
  }

  function stop() {
    stopWatcher?.();
    stopWatcher = null;
    started = false;
  }

  start();
  return { start, stop, get menu() { return appMenu; } };
}
