import { computed, onMounted, ref } from "vue";

export const FONT_STORAGE_KEY = "dbscout_ui_font";
export const FONT_WEIGHT_STORAGE_KEY = "dbscout_ui_font_weight";
export const DEFAULT_FONT_PREFERENCE = "system";
export const DEFAULT_FONT_WEIGHT = 400;

export const FONT_WEIGHT_OPTIONS = Object.freeze([
  { value: 100, label: "极细 Thin 100" },
  { value: 200, label: "特细 ExtraLight 200" },
  { value: 300, label: "细体 Light 300" },
  { value: 400, label: "常规 Regular 400" },
  { value: 500, label: "中等 Medium 500" },
  { value: 600, label: "半粗 SemiBold 600" },
  { value: 700, label: "粗体 Bold 700" },
  { value: 800, label: "特粗 ExtraBold 800" },
  { value: 900, label: "黑体 Black 900" },
]);

export const FONT_PRESETS = Object.freeze([
  { id: "system", label: "系统默认", stack: "" },
  {
    id: "microsoft-yahei",
    label: "微软雅黑",
    stack: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  },
  {
    id: "dengxian",
    label: "等线",
    stack: 'DengXian, "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  },
  {
    id: "pingfang",
    label: "苹方",
    stack: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", sans-serif',
  },
  {
    id: "source-han-sans",
    label: "思源黑体",
    stack: '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei UI", sans-serif',
  },
]);

const PRESET_BY_ID = new Map(FONT_PRESETS.map((preset) => [preset.id, preset]));
const CUSTOM_PREFIX = "custom:";
const FALLBACK_STACK = '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif';
const MAX_CUSTOM_FONT_LENGTH = 80;

export function normalizeCustomFontFamily(value) {
  const family = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!family || family.length > MAX_CUSTOM_FONT_LENGTH) return "";
  if (/[\u0000-\u001f\u007f"'\\,;{}]/.test(family)) return "";
  return family;
}

export function customFontPreference(fontFamily) {
  const family = normalizeCustomFontFamily(fontFamily);
  return family ? `${CUSTOM_PREFIX}${family}` : DEFAULT_FONT_PREFERENCE;
}

export function customFontFamily(preference) {
  if (!String(preference).startsWith(CUSTOM_PREFIX)) return "";
  return normalizeCustomFontFamily(String(preference).slice(CUSTOM_PREFIX.length));
}

export function normalizeFontPreference(value) {
  const preference = String(value ?? "").trim();
  if (PRESET_BY_ID.has(preference)) return preference;
  return customFontPreference(customFontFamily(preference));
}

export function fontStackForPreference(value) {
  const preference = normalizeFontPreference(value);
  const preset = PRESET_BY_ID.get(preference);
  if (preset) return preset.stack;

  const family = customFontFamily(preference);
  return family ? `${JSON.stringify(family)}, ${FALLBACK_STACK}` : "";
}

export function fontPreferenceLabel(value) {
  const preference = normalizeFontPreference(value);
  return PRESET_BY_ID.get(preference)?.label || customFontFamily(preference) || "系统默认";
}

export function normalizeFontWeight(value) {
  const weight = Number(value);
  return Number.isInteger(weight) && weight >= 1 && weight <= 1000 ? weight : DEFAULT_FONT_WEIGHT;
}

export function fontWeightLabel(value) {
  const weight = normalizeFontWeight(value);
  const standardLabel = FONT_WEIGHT_OPTIONS.find((option) => option.value === weight)?.label;
  if (standardLabel) return standardLabel;
  if (weight === 350) return "半细 SemiLight 350";
  if (weight === 950) return "特黑 ExtraBlack 950";
  return `字重 ${weight}`;
}

function readPreference(storage) {
  try {
    return normalizeFontPreference(storage?.getItem(FONT_STORAGE_KEY));
  } catch {
    return DEFAULT_FONT_PREFERENCE;
  }
}

function writePreference(storage, preference) {
  try {
    if (preference === DEFAULT_FONT_PREFERENCE) {
      storage?.removeItem?.(FONT_STORAGE_KEY);
    } else {
      storage?.setItem?.(FONT_STORAGE_KEY, preference);
    }
  } catch {
    // The font remains active for this session when persistence is unavailable.
  }
}

function readWeight(storage) {
  try {
    return normalizeFontWeight(storage?.getItem(FONT_WEIGHT_STORAGE_KEY));
  } catch {
    return DEFAULT_FONT_WEIGHT;
  }
}

function writeWeight(storage, weight) {
  try {
    if (weight === DEFAULT_FONT_WEIGHT) {
      storage?.removeItem?.(FONT_WEIGHT_STORAGE_KEY);
    } else {
      storage?.setItem?.(FONT_WEIGHT_STORAGE_KEY, String(weight));
    }
  } catch {
    // The weight remains active for this session when persistence is unavailable.
  }
}

export function createFontPreferenceController({
  storage = globalThis.localStorage,
  rootElement = globalThis.document?.documentElement,
} = {}) {
  const preference = ref(readPreference(storage));
  const weight = ref(readWeight(storage));
  const label = computed(() => fontPreferenceLabel(preference.value));
  const weightLabel = computed(() => fontWeightLabel(weight.value));

  function applyToRoot(value) {
    const stack = fontStackForPreference(value);
    if (stack) {
      rootElement?.style?.setProperty?.("--wb-font-ui", stack);
    } else {
      rootElement?.style?.removeProperty?.("--wb-font-ui");
    }
  }

  function start() {
    applyToRoot(preference.value);
    applyWeightToRoot(weight.value);
  }

  function applyWeightToRoot(value) {
    const normalized = normalizeFontWeight(value);
    if (normalized === DEFAULT_FONT_WEIGHT) {
      rootElement?.style?.removeProperty?.("--wb-font-weight-ui");
    } else {
      rootElement?.style?.setProperty?.("--wb-font-weight-ui", String(normalized));
    }
  }

  function setPreference(value) {
    const normalized = normalizeFontPreference(value);
    preference.value = normalized;
    writePreference(storage, normalized);
    applyToRoot(normalized);
  }

  function setWeight(value) {
    const normalized = normalizeFontWeight(value);
    weight.value = normalized;
    writeWeight(storage, normalized);
    applyWeightToRoot(normalized);
  }

  return {
    preference,
    weight,
    label,
    weightLabel,
    start,
    setPreference,
    setWeight,
  };
}

export function useFontPreference(options = {}) {
  const controller = createFontPreferenceController(options);
  onMounted(controller.start);
  return controller;
}
