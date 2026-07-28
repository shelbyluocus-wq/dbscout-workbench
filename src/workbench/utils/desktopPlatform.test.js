import test from "node:test";
import assert from "node:assert/strict";

import { detectDesktopPlatform, isMacOSPlatform } from "./desktopPlatform.js";

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
