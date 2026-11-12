// The sidebar, its titlebar strip and the first tab must stay aligned at any
// page zoom. WebKit used to apply page zoom twice to the registered sidebar
// width properties, so above 100% the translucent titlebar strip slid over the
// first tab (and the sidebar grew by the zoom factor again). The desktop app
// zooms natively; zoom on <html> stands in for it here and goes through the
// same zoom path in WebKit. Run against a Vite dev server:
//   DBSCOUT_SIDEBAR_ZOOM_TEST_URL=http://127.0.0.1:1431 node scripts/test-sidebar-zoom-browser.mjs
// DBSCOUT_BROWSER_ENGINE=webkit|chromium limits the run to one engine.
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";

const base = process.env.DBSCOUT_SIDEBAR_ZOOM_TEST_URL || "http://127.0.0.1:1431";
const engines = process.env.DBSCOUT_BROWSER_ENGINE
  ? [process.env.DBSCOUT_BROWSER_ENGINE === "webkit" ? webkit : chromium]
  : [webkit, chromium];
const ZOOMS = [0.8, 1, 1.3, 2];
const SIDEBAR_WIDTH = 319;
const RAIL_WIDTH = 40;
const TOLERANCE = 1;

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= TOLERANCE, `${message}: expected ${expected}, got ${actual}`);
}

async function measure(page) {
  return page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
    return {
      rail: rect(".wb-activity-rail").right,
      strip: rect(".wb-titlebar-sidebar").right,
      slot: rect(".wb-sidebar-slot").right,
      main: rect(".wb-main").left,
      tab: rect(".wb-tab").left,
    };
  });
}

async function run(browserType, zoom) {
  const label = `${browserType.name()} ${Math.round(zoom * 100)}%`;
  const browser = await browserType.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: Math.round(1180 * zoom), height: Math.round(760 * zoom) } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => {
      if (error.message !== "ResizeObserver loop completed with undelivered notifications.") errors.push(error.message);
    });
    await page.addInitScript((width) => {
      if (sessionStorage.getItem("sidebar-zoom-test-seeded")) return;
      sessionStorage.setItem("sidebar-zoom-test-seeded", "1");
      localStorage.clear();
      localStorage.setItem("dbscout_language", "zh-CN");
      localStorage.setItem("dbscout_sidebar_collapsed", "0");
      localStorage.setItem("dbscout_sidebar_width", String(width));
    }, SIDEBAR_WIDTH);
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForSelector(".wb-tab");
    await page.evaluate((value) => {
      // The translucent strip only exists with macOS vibrancy; it is what made the overlap visible.
      document.documentElement.setAttribute("data-wb-platform", "macos");
      document.documentElement.classList.add("is-vibrancy");
      document.documentElement.style.zoom = String(value);
    }, zoom);
    await page.waitForTimeout(500);

    const open = await measure(page);
    near(open.rail, RAIL_WIDTH * zoom, `${label}: rail edge`);
    near(open.slot, (RAIL_WIDTH + SIDEBAR_WIDTH) * zoom, `${label}: sidebar keeps its width, zoomed once`);
    near(open.strip, open.slot, `${label}: titlebar strip ends with the sidebar`);
    assert.ok(open.tab >= open.strip - 0.5, `${label}: first tab starts at ${open.tab}, under the strip ending at ${open.strip}`);

    const toggle = page.locator(".wb-titlebar-sidebar .wb-topbar-collapse-btn");
    await toggle.click();
    const samples = [];
    for (let i = 0; i < 6; i += 1) {
      await page.waitForTimeout(35);
      samples.push(await measure(page));
    }
    const collapsedEdge = RAIL_WIDTH * zoom;
    assert.ok(
      samples.some((sample) => sample.slot > collapsedEdge + 2 && sample.slot < open.slot - 2),
      `${label}: collapse animates (samples ${samples.map((sample) => sample.slot.toFixed(1)).join(", ")})`,
    );
    for (const sample of samples) {
      if (sample.slot > collapsedEdge + 0.5) near(sample.strip, sample.slot, `${label}: strip follows the sidebar while collapsing`);
    }
    await page.waitForTimeout(500);
    const collapsed = await measure(page);
    near(collapsed.slot, collapsedEdge, `${label}: collapsed sidebar`);

    await toggle.click();
    await page.waitForTimeout(700);
    const reopened = await measure(page);
    near(reopened.slot, open.slot, `${label}: sidebar reopens at its width`);
    near(reopened.strip, reopened.slot, `${label}: strip ends with the reopened sidebar`);
    assert.ok(reopened.tab >= reopened.strip - 0.5, `${label}: reopened first tab is clear of the strip`);

    assert.deepEqual(errors, [], `${label}: page errors`);
    console.log(`ok ${label}: strip ${open.strip.toFixed(1)} / sidebar ${open.slot.toFixed(1)} / tab ${open.tab.toFixed(1)}`);
  } finally {
    await browser.close();
  }
}

for (const browserType of engines) {
  for (const zoom of ZOOMS) await run(browserType, zoom);
}
console.log("sidebar zoom alignment ok");
