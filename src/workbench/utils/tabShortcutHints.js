import { detectDesktopPlatform } from "./desktopPlatform.js";

const HOME_COMBO = "Ctrl+`";
const HOME_CODE = "Backquote";

export function assignTabShortcutHints(tabs = []) {
  return tabs
    .filter((tab) => tab?.kind === "home" && tab.opening !== true)
    .map((tab) => ({ tabId: tab.id, combo: HOME_COMBO, code: HOME_CODE }));
}

export function isTabShortcutModifierHeld(event, platform = detectDesktopPlatform()) {
  return platform === "macos"
    ? Boolean(event?.metaKey && !event?.ctrlKey)
    : Boolean(event?.ctrlKey || event?.metaKey);
}

export function isTabShortcutEvent(event, platform = detectDesktopPlatform()) {
  if (!event || event.isComposing) return false;
  if (!isTabShortcutModifierHeld(event, platform) || event.shiftKey || event.altKey) return false;
  return event.code === HOME_CODE;
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
  return parsed.key === "`" || parsed.key === "backquote";
}
