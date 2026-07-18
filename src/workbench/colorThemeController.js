import { ref } from "vue";

import { COLOR_THEMES, DEFAULT_COLOR_THEME, getColorTheme, isColorThemeId } from "./colorThemes.js";

export const COLOR_THEME_STORAGE_KEY = "dbscout_color_theme";

// 与基座 token 的定义选择器保持一致，Teleport 浮层（.wb-floating-themed）自动继承。
const DARK_SELECTOR = '.mysql-workbench[data-theme="dark"], .wb-floating-themed[data-theme="dark"]';
const STYLE_ELEMENT_ID = "wb-color-theme";

export function renderColorThemeCss(theme) {
  if (!theme) return "";
  const light = Object.entries(theme.light)
    .map(([key, value]) => `${key}:${value};`)
    .join("");
  const dark = Object.entries(theme.dark)
    .map(([key, value]) => `${key}:${value};`)
    .join("");
  return `${light ? `:root{${light}}` : ""}${dark ? `${DARK_SELECTOR}{${dark}}` : ""}`;
}

function readColorThemePreference(storage) {
  try {
    const value = storage?.getItem(COLOR_THEME_STORAGE_KEY);
    return isColorThemeId(value) ? value : null;
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
} = {}) {
  const currentTheme = ref(readColorThemePreference(storage) || DEFAULT_COLOR_THEME);

  function applyStyle(id) {
    if (!documentRef?.head) return;
    const css = renderColorThemeCss(getColorTheme(id));
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

  function setColorTheme(id) {
    if (!isColorThemeId(id)) return;
    currentTheme.value = id;
    writeColorThemePreference(storage, id);
    applyStyle(id);
  }

  function start() {
    applyStyle(currentTheme.value);
  }

  return {
    currentTheme,
    themes: COLOR_THEMES,
    setColorTheme,
    start,
  };
}
