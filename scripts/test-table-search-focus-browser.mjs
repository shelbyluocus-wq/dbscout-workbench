import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, open: false },
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1264, height: 815 } });
      const errors = [];
      page.on("pageerror", (error) => {
        if (error.message !== "ResizeObserver loop completed with undelivered notifications.") errors.push(error.message);
      });
      await page.goto(server.resolvedUrls.local[0]);
      const rows = page.locator(".wb-dbhome-object-row");
      await rows.first().waitFor();
      const tableName = await rows.first().getAttribute("data-table-name");
      await rows.first().dblclick();
      const search = page.locator(".wb-workbench-pane.is-focused .wb-table-search-field-input");
      await page.waitForFunction(() => document.activeElement?.matches(".wb-table-search-field-input"));
      await page.keyboard.type("focus-check");
      assert.equal(await search.inputValue(), "focus-check", "typing after opening searches without clicking the input");
      await page.waitForTimeout(600);
      await page.locator(".wb-tab").first().click();
      await page.locator(`.wb-dbhome-object-row[data-table-name="${tableName}"]`).dblclick();
      await page.waitForFunction(() => document.activeElement?.matches(".wb-table-search-field-input"));
      assert.equal(await search.evaluate((input) => input.selectionEnd - input.selectionStart), "focus-check".length);
      await page.keyboard.type("replacement");
      assert.equal(await search.inputValue(), "replacement", "reopening selects the saved search text for replacement");
      assert.deepEqual(errors, []);
      console.log(`${engine.name()}: opening and reopening focus and select table search`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
