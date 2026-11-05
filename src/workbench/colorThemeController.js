import { ref } from "vue";

import { COLOR_THEMES, DEFAULT_COLOR_THEME, getColorTheme, isColorThemeAvailable } from "./colorThemes.js";

export const COLOR_THEME_STORAGE_KEY = "dbscout_color_theme";

// 与基座 token 的定义选择器保持一致，Teleport 浮层（.wb-floating-themed）自动继承。
const DARK_SELECTOR = '.mysql-workbench[data-theme="dark"], .wb-floating-themed[data-theme="dark"]';
const STYLE_ELEMENT_ID = "wb-color-theme";

// A preset may derive its maps from context (e.g. the "system" accent color
// on macOS) via tokens(mode, ctx) instead of static light/dark maps.
function themeModeTokens(theme, mode, ctx) {
  if (!theme) return {};
  if (typeof theme.tokens === "function") return theme.tokens(mode, ctx) || {};
  return theme[mode] || {};
}

export function renderColorThemeCss(theme, ctx = {}) {
  if (!theme) return "";
  const light = Object.entries(themeModeTokens(theme, "light", ctx))
    .map(([key, value]) => `${key}:${value};`)
    .join("");
  const dark = Object.entries(themeModeTokens(theme, "dark", ctx))
    .map(([key, value]) => `${key}:${value};`)
    .join("");
  return `${light ? `:root{${light}}` : ""}${dark ? `${DARK_SELECTOR}{${dark}}` : ""}`;
}

function readColorThemePreference(storage, { systemAccentSupported = false } = {}) {
  try {
    const value = storage?.getItem(COLOR_THEME_STORAGE_KEY);
    return isColorThemeAvailable(value, { systemAccentSupported }) ? value : null;
  } catch {
    return null;
  }
}

function writeColorThemePreference(storage, value) {
  try {
    storage?.setItem(COLOR_THEME_STORAGE_KEY, value);
  } catch {
    // 持久化被阻止时，本会话内主题切换仍然生效。
  }
}

export function createColorThemeController({
  storage = globalThis.localStorage,
  documentRef = globalThis.document,
  systemAccentSupported = false,
  // Async () => "#RRGGBB"; only invoked while the "system" preset is active
  // (and re-invoked on window focus via refreshAccent).
  accentProvider = null,
  windowRef = globalThis.window,
} = {}) {
  const currentTheme = ref(
    readColorThemePreference(storage, { systemAccentSupported }) || DEFAULT_COLOR_THEME,
  );
  const accent = ref("#007AFF");
  let accentToken = 0;
  let focusBound = false;

  function applyStyle(id) {
    if (!documentRef?.head) return;
    const css = renderColorThemeCss(getColorTheme(id), { accent: accent.value });
    let tag = documentRef.getElementById?.(STYLE_ELEMENT_ID);
    if (!css) {
      tag?.remove?.();
      return;
    }
    if (!tag) {
      tag = documentRef.createElement("style");
      tag.id = STYLE_ELEMENT_ID;
      documentRef.head.appendChild(tag);
    }
    if (tag.textContent !== css) tag.textContent = css;
  }

  async function refreshAccent() {
    if (currentTheme.value !== "system" || !accentProvider) return;
    const token = ++accentToken;
    try {
      const value = String(await accentProvider() || "").trim();
      if (token !== accentToken || !/^#[0-9a-fA-F]{6}$/.test(value)) return;
      if (value !== accent.value) {
        accent.value = value;
        applyStyle(currentTheme.value);
      }
    } catch {
      // Keep the cached accent when the read fails.
    }
  }

  function setColorTheme(id) {
    if (!isColorThemeAvailable(id, { systemAccentSupported })) return;
    currentTheme.value = id;
    writeColorThemePreference(storage, id);
    applyStyle(id);
    void refreshAccent();
  }

  function start() {
    applyStyle(currentTheme.value);
    void refreshAccent();
    if (!focusBound && windowRef?.addEventListener) {
      focusBound = true;
      windowRef.addEventListener("focus", () => void refreshAccent());
    }
  }

  return {
    currentTheme,
    // macOS-only presets are hidden from the picker on other platforms.
    themes: COLOR_THEMES.filter(
      (theme) => !theme.systemAccent || systemAccentSupported,
    ),
    accent,
    setColorTheme,
    start,
    refreshAccent,
  };
}
