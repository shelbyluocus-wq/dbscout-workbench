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
  assert.equal(formatShortcutForPlatform("Ctrl+P", { platform: "MacIntel" }), "Command+P");
  assert.equal(formatShortcutForPlatform("Cmd+Shift+P", { platform: "MacIntel" }), "Command+Shift+P");
  assert.equal(formatShortcutForPlatform("Ctrl+P", { platform: "Win32" }), "Ctrl+P");
  assert.equal(formatShortcutForPlatform("", { platform: "MacIntel" }), "");
});
