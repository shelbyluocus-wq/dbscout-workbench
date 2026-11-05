import { shortcutParts } from "../composables/useShortcuts.js";

// Pure model for the native macOS app menu. `buildNativeAppMenuModel` maps the
// workbench's orchestrator-facing state to a plain tree; the adapter in
// useNativeAppMenu.js turns it into @tauri-apps/api/menu objects. Keeping the
// tree plain makes labels, accelerators and enabled gates unit-testable.

// Tauri (muda) accelerator syntax: "CmdOrCtrl" maps to ⌘ on macOS, which is
// exactly what "Ctrl" means in the workbench's combo language (Ctrl and Cmd
// are the same primary modifier). Key names follow muda's parser — letters,
// digits, F-keys and the punctuation literals "]", "[", "`" are written as-is.
const ACCELERATOR_KEY_NAMES = Object.freeze({
  " ": "Space",
  space: "Space",
  tab: "Tab",
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
});

export function acceleratorFromCombo(combo) {
  const parsed = shortcutParts(combo);
  if (!parsed.key) return "";
  const parts = [];
  if (parsed.ctrl) parts.push("CmdOrCtrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  const key = parsed.key;
  const named = ACCELERATOR_KEY_NAMES[key.toLowerCase()];
  const keyOut = named || (key.length === 1 || /^f\d{1,2}$/i.test(key) ? key.toUpperCase() : key);
  parts.push(keyOut);
  return parts.join("+");
}

function item(id, fields = {}) {
  return { id, kind: "item", enabled: true, ...fields };
}

function predefined(id, predefined, label) {
  return { id, kind: "predefined", predefined, label, enabled: true };
}

function separator(id) {
  return { id, kind: "separator" };
}

/**
 * @param {Function} t - i18n translate
 * @param {Object} bindings - action → combo (e.g. { openSqlQuery: "Cmd+T" })
 * @param {Object} state - orchestrator snapshot:
 *   hasDataTab, canOpenDesign, canEditTableComment, canRefresh, hasNextTab,
 *   hasPrevTab, sidebarCollapsed, inspectorCollapsed, windowPinned,
 *   tools: [{ id, label, enabled, action, shortcutAction?, group? }]
 * @param {Object} options - { appName, appVersion }
 */
export function buildNativeAppMenuModel({ t, bindings = {}, state = {}, options = {} } = {}) {
  const appName = options.appName || "黑猫";
  const appVersion = options.appVersion || "";
  const accel = (action) => acceleratorFromCombo(bindings[action]);
  const bound = (action) => Boolean(bindings[action]);

  const toolItems = (state.tools || []).flatMap((tool, index) => {
    const entry = item(`tools.${tool.id || index}`, {
      label: tool.label,
      action: tool.action || tool.id,
      enabled: tool.enabled !== false,
      accelerator: tool.shortcutAction ? accel(tool.shortcutAction) : "",
      shortcutAction: tool.shortcutAction || "",
    });
    return tool.group === "more" && index === (state.tools || []).findIndex((t2) => t2.group === "more")
      ? [separator(`tools.sep.${tool.id || index}`), entry]
      : [entry];
  });

  return [
    {
      id: "app",
      label: appName,
      items: [
        { id: "app.about", kind: "about", label: t("menu.about", { name: appName }), about: { name: appName, version: appVersion }, enabled: true },
        item("app.checkUpdates", { label: t("menu.checkUpdates"), action: "checkUpdates" }),
        separator("app.sep.1"),
        item("app.settings", { label: t("menu.settings"), accelerator: "CmdOrCtrl+,", action: "openSettings" }),
        item("app.shortcutSettings", { label: t("menu.shortcutSettings"), action: "openShortcutSettings" }),
        separator("app.sep.2"),
        predefined("app.services", "Services", t("menu.services")),
        separator("app.sep.3"),
        predefined("app.hide", "Hide", t("menu.hide", { name: appName })),
        predefined("app.hideOthers", "HideOthers", t("menu.hideOthers")),
        predefined("app.showAll", "ShowAll", t("menu.showAll")),
        separator("app.sep.4"),
        predefined("app.quit", "Quit", t("menu.quit", { name: appName })),
      ],
    },
    {
      id: "file",
      label: t("menu.file"),
      items: [
        item("file.newConnection", { label: t("menu.newConnection"), action: "newConnection" }),
        item("file.openSqlQuery", { label: t("shortcut.openSqlQuery"), accelerator: accel("openSqlQuery"), action: "openSqlQuery", shortcutAction: "openSqlQuery", enabled: bound("openSqlQuery") }),
        item("file.quickOpen", { label: t("menu.quickOpen"), accelerator: accel("searchDatabase"), action: "quickOpen", shortcutAction: "searchDatabase", enabled: bound("searchDatabase") }),
        separator("file.sep.1"),
        // With no tab to close the item falls back to hiding the window, the
        // same behaviour the default menu's Close Window gives on ⌘W.
        item("file.closeTab", { label: t("menu.closeTab"), accelerator: accel("closeTab"), action: "closeTabOrHide", shortcutAction: "closeTab", enabled: bound("closeTab") }),
      ],
    },
    {
      id: "edit",
      label: t("menu.edit"),
      items: [
        predefined("edit.undo", "Undo", t("menu.undo")),
        predefined("edit.redo", "Redo", t("menu.redo")),
        separator("edit.sep.1"),
        predefined("edit.cut", "Cut", t("menu.cut")),
        predefined("edit.copy", "Copy", t("menu.copy")),
        predefined("edit.paste", "Paste", t("menu.paste")),
        predefined("edit.selectAll", "SelectAll", t("menu.selectAll")),
        separator("edit.sep.2"),
        item("edit.find", { label: t("menu.find"), accelerator: accel("searchTable"), action: "findInTable", shortcutAction: "searchTable", enabled: bound("searchTable") && state.hasDataTab === true }),
        item("edit.replace", { label: t("menu.replace"), accelerator: accel("replaceInTable"), action: "replaceInTable", shortcutAction: "replaceInTable", enabled: bound("replaceInTable") && state.hasDataTab === true }),
      ],
    },
    {
      id: "table",
      label: t("menu.table"),
      items: [
        item("table.openDesign", { label: t("menu.openDesign"), accelerator: accel("openDesign"), action: "openDesign", shortcutAction: "openDesign", enabled: bound("openDesign") && state.canOpenDesign === true }),
        item("table.editTableComment", { label: t("menu.editTableComment"), accelerator: accel("editTableComment"), action: "editTableComment", shortcutAction: "editTableComment", enabled: bound("editTableComment") && state.canEditTableComment === true }),
        item("table.refresh", { label: t("menu.refresh"), accelerator: accel("refresh"), action: "refresh", shortcutAction: "refresh", enabled: bound("refresh") && state.canRefresh === true }),
      ],
    },
    {
      id: "tools",
      label: t("menu.tools"),
      items: toolItems,
    },
    {
      id: "view",
      label: t("menu.view"),
      items: [
        // Labels follow the collapsed state (Finder-style Show/Hide), so they
        // are excluded from the rebuild signature and updated in place.
        item("view.sidebar", { label: state.sidebarCollapsed ? t("menu.showSidebar") : t("menu.hideSidebar"), action: "toggleSidebar", dynamicLabel: true }),
        item("view.inspector", { label: state.inspectorCollapsed ? t("menu.showInspector") : t("menu.hideInspector"), action: "toggleInspector", dynamicLabel: true }),
        separator("view.sep.1"),
        {
          id: "view.appearance",
          kind: "submenu",
          label: t("m_86a63f23a076"),
          enabled: true,
          items: [
            { id: "view.appearance.light", kind: "check", label: t("m_aa0819dfc4d8"), action: "appearanceLight", checked: state.themePreference === "light", enabled: true },
            { id: "view.appearance.dark", kind: "check", label: t("m_a6b75d068032"), action: "appearanceDark", checked: state.themePreference === "dark", enabled: true },
            { id: "view.appearance.system", kind: "check", label: t("m_c9a1f2b3d4e5"), action: "appearanceSystem", checked: state.themePreference !== "light" && state.themePreference !== "dark", enabled: true },
          ],
        },
        separator("view.sep.2"),
        item("view.zoomIn", { label: t("pageZoom.in"), accelerator: "CmdOrCtrl+=", action: "zoomIn", shortcutAction: "zoomIn" }),
        item("view.zoomOut", { label: t("pageZoom.out"), accelerator: "CmdOrCtrl+-", action: "zoomOut", shortcutAction: "zoomOut" }),
        item("view.zoomReset", { label: t("pageZoom.reset"), accelerator: "CmdOrCtrl+0", action: "zoomReset", shortcutAction: "zoomReset" }),
        separator("view.sep.zoom"),
        predefined("view.fullscreen", "Fullscreen", t("menu.fullscreen")),
      ],
    },
    {
      id: "window",
      label: t("menu.window"),
      role: "windowMenu",
      items: [
        predefined("window.minimize", "Minimize", t("menu.minimize")),
        predefined("window.zoom", "Maximize", t("menu.zoom")),
        separator("window.sep.1"),
        item("window.nextTab", { label: t("shortcut.nextTab"), accelerator: accel("nextTab"), action: "nextTab", shortcutAction: "nextTab", enabled: bound("nextTab") && state.hasNextTab === true }),
        item("window.previousTab", { label: t("shortcut.previousTab"), accelerator: accel("previousTab"), action: "previousTab", shortcutAction: "previousTab", enabled: bound("previousTab") && state.hasPrevTab === true }),
        separator("window.sep.2"),
        { id: "window.pinWindow", kind: "check", label: t("menu.pinWindow"), accelerator: accel("pinWindow"), action: "togglePinWindow", shortcutAction: "pinWindow", enabled: bound("pinWindow"), checked: state.windowPinned === true },
        separator("window.sep.3"),
        predefined("window.bringAllToFront", "BringAllToFront", t("menu.bringAllToFront")),
      ],
    },
    {
      id: "help",
      label: t("menu.help"),
      role: "helpMenu",
      items: [
        item("help.shortcuts", { label: t("menu.shortcutList"), action: "openShortcutSettings" }),
      ],
    },
  ];
}

// Structural signature: the adapter rebuilds the Tauri menu only when this
// changes (language, bindings, item structure). Dynamic labels, enabled
// flags and checked states update in place and are excluded on purpose.
export function nativeAppMenuSignature(model = []) {
  return JSON.stringify(
    model.map((submenu) => [
      submenu.id,
      submenu.label,
      (submenu.items || []).map((entry) => [
        entry.id,
        entry.kind,
        entry.dynamicLabel ? "" : entry.label || "",
        entry.accelerator || "",
        entry.predefined || "",
        entry.about ? JSON.stringify(entry.about) : "",
      ]),
    ]),
  );
}
