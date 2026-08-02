import { onBeforeUnmount, onMounted, ref, watch } from "vue";

// 切库流光：跨数据库切换标签时，沿中间内容区三边（左/顶/右）播放一段流光，
// 并在区域中央浮现「引擎 · 数据库显示名」，提醒用户当前所在的库。
export const GLOW_DURATION = 1900;

const GLOW_COLOR_STORAGE_KEY = "dbscout_glow_color";
const GLOW_COLOR_LIGHT_KEY = `${GLOW_COLOR_STORAGE_KEY}_light`;
const GLOW_COLOR_DARK_KEY = `${GLOW_COLOR_STORAGE_KEY}_dark`;
const GLOW_CUSTOM_TOKEN = "--wb-glow-custom";

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

// 预设模板色：浅色/深色各一个 hex，套用与 databaseDecorationStore 文本色相同的双档结构。
export const GLOW_COLOR_PRESETS = Object.freeze([
  { value: "preset:teal", label: "猫眼青", light: "#0d9488", dark: "#2dd4bf" },
  { value: "preset:azure", label: "湛蓝", light: "#2563eb", dark: "#60a5fa" },
  { value: "preset:violet", label: "紫罗兰", light: "#7c3aed", dark: "#a78bfa" },
  { value: "preset:amber", label: "琥珀", light: "#d97706", dark: "#fbbf24" },
  { value: "preset:rose", label: "玫红", light: "#e11d48", dark: "#fb7185" },
]);

const GLOW_COLOR_PRESET_MAP = new Map(GLOW_COLOR_PRESETS.map((preset) => [preset.value, preset]));

// 把存储值（preset:<id> 或 #hex）解析成当前主题下的实际颜色；无效/空值返回 ""（回落 CSS 默认）。
export function resolveGlowColorCss(value, theme = "light") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  const preset = GLOW_COLOR_PRESET_MAP.get(normalized);
  if (preset) return theme === "dark" ? preset.dark : preset.light;
  return HEX_COLOR_PATTERN.test(normalized) ? normalized : "";
}

// 引擎前缀文案：与 HomeDatabaseFavorites 的 engineLabel 口径一致（mysql → MySQL，其余 clickhouse → ClickHouse）。
export function glowEngineLabel(kind) {
  return String(kind || "mysql").toLowerCase() === "clickhouse" ? "ClickHouse" : "MySQL";
}

function tabDatabaseKey(tab) {
  const database = String(tab?.database || "").trim();
  if (!database) return "";
  // 与 workspaceState.js 的 databaseKey 口径一致（单元分隔符，避免拼接歧义）。
  return [tab?.connectionId, tab?.database].map((value) => String(value ?? "").trim()).join("\u001f");
}

/**
 * 判定一次标签激活变化是否需要播放切库流光。
 * 规则（与产品口径对齐）：
 * - 切后的标签必须属于某个数据库（SQL 文件库等无库标签不播）；
 * - 切前的标签也必须属于某个数据库（首开标签、从无库标签切来不播）；
 * - 前后不同库才播（同库标签互切不播）；
 * - 当前打开的标签需覆盖至少 2 个数据库。
 * 命中时返回 { connectionId, database }，否则返回 null。
 */
export function resolveSwitchGlow({ tabs = [], prevTabId = "", nextTabId = "" } = {}) {
  if (!nextTabId || nextTabId === prevTabId) return null;
  const nextTab = tabs.find((tab) => tab?.id === nextTabId);
  const prevTab = tabs.find((tab) => tab?.id === prevTabId);
  const nextKey = tabDatabaseKey(nextTab);
  const prevKey = tabDatabaseKey(prevTab);
  if (!nextKey || !prevKey || nextKey === prevKey) return null;
  const distinctDatabases = new Set(tabs.map(tabDatabaseKey).filter(Boolean));
  if (distinctDatabases.size < 2) return null;
  return {
    connectionId: String(nextTab.connectionId ?? ""),
    database: String(nextTab.database ?? ""),
  };
}

// 播放状态：play() 推入一条带自增 id 的播放记录，到期按 id 清除；重复触发自然重播。
export function createDatabaseSwitchGlow({ duration = GLOW_DURATION } = {}) {
  const playback = ref(null);
  let sequence = 0;
  let timer = 0;

  function clearTimer() {
    if (timer) {
      globalThis.clearTimeout?.(timer);
      timer = 0;
    }
  }

  function stop() {
    clearTimer();
    playback.value = null;
  }

  function play(payload = {}) {
    sequence += 1;
    const id = sequence;
    playback.value = {
      id,
      engine: String(payload.engine || "MySQL"),
      label: String(payload.label || ""),
      markerColor: String(payload.markerColor || ""),
    };
    clearTimer();
    timer = globalThis.setTimeout?.(() => {
      timer = 0;
      if (playback.value?.id === id) playback.value = null;
    }, duration) || 0;
  }

  return { playback, play, stop };
}

function storageKeyForTheme(theme) {
  return theme === "dark" ? GLOW_COLOR_DARK_KEY : GLOW_COLOR_LIGHT_KEY;
}

function normalizeTheme(theme) {
  return theme === "dark" ? "dark" : "light";
}

function readStored(storage, theme) {
  try {
    const themeKey = storageKeyForTheme(theme);
    const themeValue = storage?.getItem(themeKey);
    if (themeValue) return themeValue;

    const legacyValue = storage?.getItem(GLOW_COLOR_STORAGE_KEY) || "";
    if (legacyValue) {
      storage?.setItem(themeKey, legacyValue);
      storage?.removeItem(GLOW_COLOR_STORAGE_KEY);
    }
    return legacyValue;
  } catch {
    return "";
  }
}

function writeStored(storage, theme, value) {
  try {
    const key = storageKeyForTheme(theme);
    if (value) storage?.setItem(key, value);
    else storage?.removeItem(key);
  } catch {
    // best-effort persistence
  }
}

/**
 * 特效颜色偏好：浅色/深色分别记忆，解析后写入根变量 --wb-glow-custom，
 * CSS 侧的 --wb-glow-color 以 var(--wb-glow-custom, <主题默认>) 引用。
 * 结构与 useCellHighlight 保持一致。
 *
 * @param {object} options
 * @param {Storage} [options.storage] - localStorage by default.
 * @param {HTMLElement} [options.root] - document.documentElement by default.
 * @param {Function} [options.getTheme] - returns "light" or "dark".
 */
export function createGlowColorController({
  storage = globalThis.localStorage,
  root = globalThis.document?.documentElement,
  getTheme = () => globalThis.document?.querySelector?.(".mysql-workbench")?.getAttribute?.("data-theme") || "light",
} = {}) {
  const activeTheme = () => normalizeTheme(getTheme());
  const color = ref(readStored(storage, activeTheme()));

  function apply(value) {
    if (!root?.style?.setProperty) return;
    const resolved = resolveGlowColorCss(value, activeTheme());
    if (resolved) root.style.setProperty(GLOW_CUSTOM_TOKEN, resolved);
    else root.style.removeProperty(GLOW_CUSTOM_TOKEN);
  }

  function setColor(value) {
    color.value = String(value || "").trim().toLowerCase();
    writeStored(storage, activeTheme(), color.value);
    apply(color.value);
  }

  function clear() {
    setColor("");
  }

  function syncTheme() {
    color.value = readStored(storage, activeTheme());
    apply(color.value);
  }

  return { color, setColor, clear, apply, syncTheme };
}

export function useGlowColor(options = {}) {
  const controller = createGlowColorController(options);

  onMounted(() => controller.syncTheme());
  const stopThemeWatch = options.themeRef
    ? watch(options.themeRef, () => controller.syncTheme())
    : () => {};

  onBeforeUnmount(() => {
    stopThemeWatch();
  });

  return controller;
}
