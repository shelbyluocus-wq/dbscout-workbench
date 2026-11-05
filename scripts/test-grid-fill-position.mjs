import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, open: false },
});

async function geometry(page) {
  return page.evaluate(() => {
    const selected = document.querySelector(".wb-grid td.selected");
    const handle = document.querySelector(".wb-fill-handle");
    if (!selected || !handle) return null;
    const cellRect = selected.getBoundingClientRect();
    const handleRect = handle.getBoundingClientRect();
    const style = getComputedStyle(handle);
    return {
      horizontalError: handleRect.left - cellRect.right - parseFloat(style.left),
      verticalError: handleRect.top - cellRect.bottom - parseFloat(style.top),
      cellBottom: cellRect.bottom,
      cellRight: cellRect.right,
    };
  });
}

async function assertAligned(page, label) {
  let actual;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(25);
    actual = await geometry(page);
    if (actual && Math.abs(actual.horizontalError) < 1 && Math.abs(actual.verticalError) < 1) return actual;
  }
  assert.fail(`${label}: ${JSON.stringify(actual)}`);
}

async function dragHandle(page, locator, deltaX, deltaY, checkDuringDrag = null) {
  const box = await locator.boundingBox();
  assert.ok(box, "resize handle is visible");
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 8 });
  await checkDuringDrag?.();
  await page.mouse.up();
}

try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      await page.addInitScript(() => localStorage.setItem("dbscout_language", "zh-CN"));
      await page.goto(url);
      await page.getByRole("option", { name: "player", exact: true }).dblclick();
      const cell = page.locator('td[data-visual-row-index="4"][data-column-index="3"]');
      await cell.click();
      await page.locator(".wb-fill-handle").waitFor();
      const initial = await assertAligned(page, "initial selection");
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await page.locator(".wb-field-comments-toggle").click();
        await page.waitForTimeout(200);
        const collapsed = await assertAligned(page, "collapsed comments");
        assert.ok(collapsed.cellBottom < initial.cellBottom - 10, "collapse moves the selected cell");
        await page.locator(".wb-field-comments-toggle").click();
        await page.waitForTimeout(200);
        await assertAligned(page, "expanded comments");
      }
      await dragHandle(page, page.locator(".wb-field-comments-resize-handle"), 0, 32);
      const tallerHeader = await assertAligned(page, "comment height drag");
      assert.ok(tallerHeader.cellBottom > initial.cellBottom + 20, "comment resize moves the cell");
      await page.locator(".wb-field-comments-resize-handle").dblclick();
      await assertAligned(page, "reset comment height");
      const rowResize = page.locator('tr[data-row-selection-index="4"] .wb-row-resize-handle');
      await dragHandle(page, rowResize, 0, 8, async () => {
        const tallerRows = await assertAligned(page, "data row height drag");
        assert.ok(tallerRows.cellBottom > initial.cellBottom + 20, "row resize moves the cell");
      });
      await rowResize.dblclick();
      await cell.click();
      const beforeColumnResize = await assertAligned(page, "reset data row height");
      await page.locator('.wb-grid-column-header-row th[data-column-index="3"] .wb-col-resize').press("Shift+ArrowRight");
      const widerColumn = await assertAligned(page, "column width adjustment");
      assert.ok(widerColumn.cellRight > beforeColumnResize.cellRight + 20, `column resize moves the cell edge: ${JSON.stringify({ beforeColumnResize, widerColumn })}`);
      await page.setViewportSize({ width: 1120, height: 740 });
      await assertAligned(page, "viewport resize");
      await page.locator(".wb-grid-wrap").evaluate((element) => { element.scrollTop = 56; });
      await assertAligned(page, "scroll");
      await cell.click();
      await assertAligned(page, "reselection after layout changes");
      await page.screenshot({ path: `/tmp/blackcat-fill-position-${engine.name()}.png` });
      console.log(`${engine.name()}: fill handle remains aligned after collapse/expand, header and row resize/reset, column resize, viewport resize, scroll and reselection`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
