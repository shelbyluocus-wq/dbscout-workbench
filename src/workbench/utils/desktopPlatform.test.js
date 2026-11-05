import test from "node:test";
import assert from "node:assert/strict";

import {
  detectDesktopPlatform,
  formatShortcutForPlatform,
  isMacOSPlatform,
} from "./desktopPlatform.js";

test("detectDesktopPlatform recognizes modern and legacy macOS signals", () => {
  assert.equal(
    detectDesktopPlatform({ userAgentData: { platform: "macOS" } }),
    "macos",
  );
  assert.equal(
    detectDesktopPlatform({ platform: "MacIntel" }),
    "macos",
  );
  assert.equal(
    isMacOSPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }),
    true,
  );
});

test("detectDesktopPlatform keeps Windows and Linux out of the macOS path", () => {
  assert.equal(detectDesktopPlatform({ platform: "Win32" }), "windows");
  assert.equal(detectDesktopPlatform({ platform: "Linux x86_64" }), "linux");
  assert.equal(isMacOSPlatform({ platform: "Win32" }), false);
  assert.equal(detectDesktopPlatform({}), "unknown");
});

test("formatShortcutForPlatform presents the primary modifier for each platform", () => {
  assert.equal(formatShortcutForPlatform("Ctrl+P", { platform: "Win32" }), "Ctrl+P");
  assert.equal(formatShortcutForPlatform("Alt+Shift+F", { platform: "Win32" }), "Alt+Shift+F");
  assert.equal(formatShortcutForPlatform("", { platform: "MacIntel" }), "");
});

test("formatShortcutForPlatform renders Apple modifier glyphs on macOS", () => {
  const mac = { platform: "MacIntel" };
  // Ctrl and Cmd are the same (primary) modifier in the combo language, so
  // both render as ⌘.
  assert.equal(formatShortcutForPlatform("Ctrl+P", mac), "⌘P");
  assert.equal(formatShortcutForPlatform("Cmd+P", mac), "⌘P");
  assert.equal(formatShortcutForPlatform("Cmd+Alt+F", mac), "⌥⌘F");
  assert.equal(formatShortcutForPlatform("Cmd+Shift+T", mac), "⇧⌘T");
  assert.equal(formatShortcutForPlatform("Cmd+Shift+]", mac), "⇧⌘]");
  assert.equal(formatShortcutForPlatform("Cmd+Shift+[", mac), "⇧⌘[");
  assert.equal(formatShortcutForPlatform("Ctrl+`", mac), "⌘`");
  assert.equal(formatShortcutForPlatform("Ctrl+1", mac), "⌘1");
  assert.equal(formatShortcutForPlatform("Alt+Shift+F", mac), "⌥⇧F");
  // Modifier-only combos keep the glyph (e.g. "⌘+Click" hints).
  assert.equal(formatShortcutForPlatform("Ctrl", mac), "⌘");
  // Named keys keep readable labels; F-keys stay unchanged.
  assert.equal(formatShortcutForPlatform("F5", mac), "F5");
  assert.equal(formatShortcutForPlatform("F8", mac), "F8");
  assert.equal(formatShortcutForPlatform("Shift+F10", mac), "⇧F10");
  assert.equal(formatShortcutForPlatform("Backspace", mac), "⌫");
  assert.equal(formatShortcutForPlatform("Enter", mac), "↩");
  assert.equal(formatShortcutForPlatform("Escape", mac), "⎋");
  assert.equal(formatShortcutForPlatform("Ctrl+Tab", mac), "⌘⇥");
  assert.equal(formatShortcutForPlatform("Ctrl+ArrowLeft", mac), "⌘←");
});
