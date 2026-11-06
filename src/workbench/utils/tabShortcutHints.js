import { detectDesktopPlatform } from "./desktopPlatform.js";

const HOME_COMBO = "Ctrl+`";
const HOME_CODE = "Backquote";
const MAX_NUMBERED_TABS = 9;

function isPublishedShortcutTab(tab) {
  return Boolean(tab) && tab.opening !== true;
}

function isHomeTab(tab) {
  return tab?.kind === "home";
}

export function assignTabShortcutHints(tabs = []) {
  const published = tabs.filter(isPublishedShortcutTab);
  const homes = published.filter(isHomeTab);
  const others = published.filter((tab) => !isHomeTab(tab));
  const hints = homes.map((tab) => ({
    tabId: tab.id,
    combo: HOME_COMBO,
    code: HOME_CODE,
  }));
  others.slice(0, MAX_NUMBERED_TABS).forEach((tab, index) => {
    const number = index + 1;
    hints.push({
      tabId: tab.id,
      combo: `Ctrl+${number}`,
      code: `Digit${number}`,
    });
  });
  return hints;
}

export function isTabShortcutModifierHeld(event, platform = detectDesktopPlatform()) {
  return platform === "macos"
    ? Boolean(event?.metaKey && !event?.ctrlKey)
    : Boolean(event?.ctrlKey || event?.metaKey);
}

export function isTabShortcutEvent(event, platform = detectDesktopPlatform()) {
  if (!event || event.isComposing) return false;
  if (!isTabShortcutModifierHeld(event, platform) || event.shiftKey || event.altKey) return false;
  if (event.code === HOME_CODE) return true;
  return /^Digit[1-9]$/.test(String(event.code || ""));
}

export function resolveTabShortcutEvent(event, tabs = [], platform = detectDesktopPlatform()) {
  if (!isTabShortcutEvent(event, platform)) return null;
  const hints = assignTabShortcutHints(tabs);
  const matched = hints.find((hint) => hint.code === event.code);
  if (matched) return matched;
  if (event.code === HOME_CODE) {
    return { tabId: "", combo: HOME_COMBO, code: HOME_CODE };
  }
  return null;
}

function shortcutParts(combo) {
  const parts = String(combo || "").split("+").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const key = parts.pop() || "";
  return {
    key,
    ctrl: parts.includes("ctrl") || parts.includes("cmd") || parts.includes("command"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt") || parts.includes("option"),
  };
}

export function isReservedTabShortcutCombo(combo) {
  const parsed = shortcutParts(combo);
  if (!parsed.ctrl || parsed.shift || parsed.alt) return false;
  return parsed.key === "`" || parsed.key === "backquote" || /^[1-9]$/.test(parsed.key);
}
