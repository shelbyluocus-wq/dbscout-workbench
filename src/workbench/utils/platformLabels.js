import { t } from "../i18n/index.js";
import { isMacOSPlatform } from "./desktopPlatform.js";

// Platform-specific label variants live as "<key>.macos" catalog entries so
// the default (Windows) copy is untouched. tPlatform picks the macOS variant
// when running on a Mac (e.g. "在访达中显示" instead of "打开资源管理器").
export function tPlatform(key, translate = t, navigatorLike = globalThis.navigator) {
  if (isMacOSPlatform(navigatorLike)) {
    const value = translate(`${key}.macos`);
    if (value && value !== `${key}.macos`) return value;
  }
  return translate(key);
}
