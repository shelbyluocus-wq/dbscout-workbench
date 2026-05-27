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

export function createThemeController({
  storage = globalThis.localStorage,
  mediaQuery = defaultMediaQuery(),
  applyNativeTheme,
} = {}) {
  const manualPreference = ref(readThemePreference(storage));
  const effectiveTheme = ref(manualPreference.value || systemTheme(mediaQuery));
  const isDark = computed(() => effectiveTheme.value === DARK_THEME);
  let started = false;
  let removeMediaListener = () => {};

  function applyTheme(theme) {
    effectiveTheme.value = theme;
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

  return {
    effectiveTheme,
    isDark,
    manualPreference,
    start,
    stop,
    toggleTheme,
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
