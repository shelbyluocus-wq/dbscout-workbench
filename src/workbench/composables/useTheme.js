import { computed, onBeforeUnmount, onMounted, ref } from "vue";

export const THEME_STORAGE_KEY = "dbscout_theme";

const LIGHT_THEME = "light";
const DARK_THEME = "dark";

function isTheme(value) {
  return value === LIGHT_THEME || value === DARK_THEME;
}

function readThemePreference(storage) {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

function writeThemePreference(storage, value) {
  try {
    storage?.setItem(THEME_STORAGE_KEY, value);
  } catch {
    // Theme selection still works for this session when persistence is blocked.
  }
}

function systemTheme(mediaQuery) {
  return mediaQuery?.matches ? DARK_THEME : LIGHT_THEME;
}

function defaultMediaQuery() {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
}

function applyThemeQuietly(applyNativeTheme, theme) {
  try {
    const result = applyNativeTheme?.(theme);
    result?.catch?.(() => {});
  } catch {
    // Browser previews and unsupported native environments keep the web theme.
  }
}

function rootBackgroundToken(theme) {
  return theme === DARK_THEME
    ? "var(--wb-root-background-dark)"
    : "var(--wb-root-background-light)";
}

function rootBackgroundColor(theme) {
  return theme === DARK_THEME ? "#0c0c0e" : "#eaebed";
}

export function createThemeController({
  storage = globalThis.localStorage,
  mediaQuery = defaultMediaQuery(),
  applyNativeTheme,
  rootElement = globalThis.document?.documentElement,
  bodyElement = globalThis.document?.body,
  // When macOS vibrancy is on (the is-vibrancy root class), html/body must
  // stay transparent so the native blur shows through — the inline solid
  // background would cover it.
  suppressRootBackground = () => globalThis.document?.documentElement?.classList?.contains?.("is-vibrancy") === true,
} = {}) {
  const manualPreference = ref(readThemePreference(storage));
  const effectiveTheme = ref(manualPreference.value || systemTheme(mediaQuery));
  const isDark = computed(() => effectiveTheme.value === DARK_THEME);
  let started = false;
  let removeMediaListener = () => {};

  function applyTheme(theme) {
    effectiveTheme.value = theme;
    if (rootElement?.dataset) rootElement.dataset.wbTheme = theme;
    if (bodyElement?.dataset) bodyElement.dataset.wbTheme = theme;
    rootElement?.style?.setProperty?.("--wb-root-background", rootBackgroundToken(theme));
    const background = suppressRootBackground() ? "transparent" : rootBackgroundColor(theme);
    if (rootElement?.style) rootElement.style.backgroundColor = background;
    if (bodyElement?.style) bodyElement.style.backgroundColor = background;
    applyThemeQuietly(applyNativeTheme, theme);
  }

  function onSystemThemeChange(event) {
    if (manualPreference.value) return;
    applyTheme(event.matches ? DARK_THEME : LIGHT_THEME);
  }

  function start() {
    if (started) return;
    started = true;
    applyTheme(effectiveTheme.value);

    if (mediaQuery?.addEventListener) {
      mediaQuery.addEventListener("change", onSystemThemeChange);
      removeMediaListener = () => mediaQuery.removeEventListener("change", onSystemThemeChange);
    } else if (mediaQuery?.addListener) {
      mediaQuery.addListener(onSystemThemeChange);
      removeMediaListener = () => mediaQuery.removeListener(onSystemThemeChange);
    }
  }

  function stop() {
    if (!started) return;
    removeMediaListener();
    started = false;
    removeMediaListener = () => {};
  }

  function toggleTheme() {
    const nextTheme = isDark.value ? LIGHT_THEME : DARK_THEME;
    manualPreference.value = nextTheme;
    writeThemePreference(storage, nextTheme);
    applyTheme(nextTheme);
  }

  // "system" clears the stored choice so the theme follows
  // prefers-color-scheme live (the mediaQuery listener only acts when there
  // is no manual preference).
  function setThemePreference(theme) {
    if (theme === "system") {
      manualPreference.value = null;
      try {
        storage?.removeItem(THEME_STORAGE_KEY);
      } catch {
        // Persistence blocked — the session still follows the system.
      }
      applyTheme(systemTheme(mediaQuery));
      return;
    }
    if (!isTheme(theme)) return;
    manualPreference.value = theme;
    writeThemePreference(storage, theme);
    applyTheme(theme);
  }

  const preference = computed(() => manualPreference.value || "system");

  // Re-applies the current theme (incl. the html/body background) — needed
  // when vibrancy flips the inline-background rule at runtime.
  function refresh() {
    applyTheme(effectiveTheme.value);
  }

  return {
    effectiveTheme,
    isDark,
    manualPreference,
    preference,
    start,
    stop,
    toggleTheme,
    setThemePreference,
    refresh,
  };
}

export async function applyNativeWindowTheme(theme) {
  if (!globalThis.__TAURI_INTERNALS__) return;

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTheme(theme);
}

export function useTheme(options = {}) {
  const theme = createThemeController({
    applyNativeTheme: applyNativeWindowTheme,
    ...options,
  });

  onMounted(theme.start);
  onBeforeUnmount(theme.stop);
  return theme;
}
