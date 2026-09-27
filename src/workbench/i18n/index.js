import { computed, ref } from "vue";
import en from "./en.js";
import zhCN from "./zhCN.js";
import zhTW from "./zhTW.js";

export const LANGUAGE_STORAGE_KEY = "dbscout_language";
export const SUPPORTED_LANGUAGES = Object.freeze(["en", "zh-CN", "zh-TW"]);
const catalogs = Object.freeze({ en, "zh-CN": zhCN, "zh-TW": zhTW });

function localStorageOrNull() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function readLanguagePreference(storage) {
  try {
    const saved = storage?.getItem(LANGUAGE_STORAGE_KEY);
    if (SUPPORTED_LANGUAGES.includes(saved)) return saved;
    if (saved !== null && saved !== undefined) return "en";
    // Existing installations were Chinese-only. Preserve their experience,
    // without guessing a person's location from browser/OS locale or timezone.
    for (let index = 0; index < (storage?.length ?? 0); index += 1) {
      if (/^dbscout[_.-]/.test(storage.key(index) ?? "")) return "zh-CN";
    }
  } catch {
    // The in-memory preference still works when storage is unavailable.
  }
  return "en";
}

export function createLanguageController({ storage = localStorageOrNull() } = {}) {
  const locale = ref(readLanguagePreference(storage));
  const intlLocale = computed(() => locale.value);
  function setLanguage(next) {
    if (!SUPPORTED_LANGUAGES.includes(next)) return false;
    locale.value = next;
    try { storage?.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Session-only preference. */ }
    return true;
  }
  function translate(key, parameters = {}) {
    const message = catalogs[locale.value]?.[key] ?? en[key] ?? key;
    return message.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) =>
      Object.hasOwn(parameters, name) ? String(parameters[name]) : match);
  }
  // Persist migration before other startup preferences can make a new install
  // look like an existing installation on its next launch.
  setLanguage(locale.value);
  return { locale, intlLocale, setLanguage, t: translate };
}

export const language = createLanguageController();
export const t = language.t;
