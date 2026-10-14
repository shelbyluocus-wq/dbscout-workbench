// What the relation-page browser regressions share: the frontend to test,
// where screenshots go, and the browser to drive.
import { chromium } from "playwright";
import { tmpdir } from "node:os";

export const base = process.env.DBSCOUT_RELATIONS_TEST_URL || "http://127.0.0.1:1431";
export const shots = process.env.DBSCOUT_RELATIONS_SCREENSHOTS || tmpdir();
// e.g. "msedge" or "chrome" to use an installed browser instead of Playwright's.
const channel = process.env.DBSCOUT_PLAYWRIGHT_CHANNEL || undefined;

export function launchBrowser() {
  return chromium.launch({ headless: true, channel });
}
