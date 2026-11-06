import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, open: false },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
    localStorage.setItem("dbscout_language", "zh-CN");
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator(".wb-tab-home-icon").first().waitFor();
  for (const collapsed of [false, true]) {
    const sidebarCollapsed = await page.locator(".wb-titlebar-sidebar").evaluate((element) => element.classList.contains("is-collapsed"));
    if (sidebarCollapsed !== collapsed) await page.locator(".wb-titlebar-sidebar .wb-topbar-collapse-btn").click();
    await page.locator(`.wb-titlebar-sidebar${collapsed ? ".is-collapsed" : ":not(.is-collapsed)"}`).waitFor();
    for (const zoom of [0.5, 1, 1.2, 1.5, 2]) {
      await page.evaluate((scale) => { document.documentElement.style.zoom = String(scale); }, zoom);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const centers = await page.evaluate(() => {
        const center = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.top + rect.height / 2;
        };
        return {
          titlebar: center(document.querySelector(".wb-titlebar")),
          home: center(document.querySelector(".wb-tab-home-icon")),
          arrows: [...document.querySelectorAll(".wb-topbar-collapse-btn")].map(center),
          controls: [...document.querySelectorAll(".wb-window-icon")].map(center),
        };
      });
      assert.equal(centers.controls.length, 3);
      for (const [kind, values] of Object.entries(centers)) {
        for (const value of [values].flat()) {
          assert.ok(Math.abs(value - centers.titlebar) <= zoom / 2 + 0.1,
            `${kind} is not centered at zoom ${zoom}: ${JSON.stringify(centers)}`);
        }
      }
      console.log(JSON.stringify({ collapsed, zoom, ...centers }));
    }
    await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
  }
} finally {
  await browser?.close();
  await server.close();
}
