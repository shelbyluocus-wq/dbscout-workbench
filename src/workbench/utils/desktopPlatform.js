export function detectDesktopPlatform(navigatorLike = globalThis.navigator) {
  const platformSignals = [
    navigatorLike?.userAgentData?.platform,
    navigatorLike?.platform,
    navigatorLike?.userAgent,
  ]
    .filter(Boolean)
    .join(" ");

  if (/(?:Macintosh|MacIntel|MacPPC|Mac68K|\bmacOS\b)/i.test(platformSignals)) {
    return "macos";
  }
  if (/(?:Windows|Win32|Win64)/i.test(platformSignals)) {
    return "windows";
  }
  if (/(?:Linux|X11)/i.test(platformSignals)) {
    return "linux";
  }
  return "unknown";
}

export function isMacOSPlatform(navigatorLike = globalThis.navigator) {
  return detectDesktopPlatform(navigatorLike) === "macos";
}

// Apple modifier order is ⌃⌥⇧⌘. The combo language treats Ctrl and Cmd as
// the same (primary) modifier, so both map to ⌘ and the ⌃ slot stays unused.
const MAC_MODIFIER_ORDER = Object.freeze(["control", "option", "shift", "command"]);
const MAC_MODIFIER_GLYPHS = Object.freeze({ control: "⌃", option: "⌥", shift: "⇧", command: "⌘" });
const MAC_MODIFIER_TOKENS = Object.freeze({
  ctrl: "command",
  control: "command",
  cmd: "command",
  command: "command",
  meta: "command",
  super: "command",
  alt: "option",
  option: "option",
  shift: "shift",
});
const MAC_KEY_GLYPHS = Object.freeze({
  backspace: "⌫",
  delete: "⌫",
  enter: "↩",
  return: "↩",
  escape: "⎋",
  esc: "⎋",
  tab: "⇥",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
});

function formatShortcutForMac(parts) {
  const modifiers = new Set();
  let key = "";
  for (const part of parts) {
    const token = part.toLowerCase();
    const slot = MAC_MODIFIER_TOKENS[token];
    if (slot) {
      modifiers.add(slot);
    } else {
      key = part;
    }
  }
  const keyLabel = MAC_KEY_GLYPHS[key.toLowerCase()] || (key.length === 1 ? key.toUpperCase() : key);
  return MAC_MODIFIER_ORDER.filter((slot) => modifiers.has(slot))
    .map((slot) => MAC_MODIFIER_GLYPHS[slot])
    .join("") + keyLabel;
}

export function formatShortcutForPlatform(shortcut, navigatorLike = globalThis.navigator) {
  const parts = String(shortcut || "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  if (!isMacOSPlatform(navigatorLike)) return parts.join("+");

  return formatShortcutForMac(parts);
}
