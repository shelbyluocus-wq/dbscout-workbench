import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.DBSCOUT_GRID_TEST_URL || "http://127.0.0.1:8099";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, permissions: ["clipboard-read", "clipboard-write"] });
  await context.addInitScript(() => localStorage.setItem("dbscout_language", "zh-CN"));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/?perfProfile=deterministic-v1&scenario=schema-800x60`);
  await page.locator('[role="option"]').first().dblclick();
  const wrap = page.locator(".wb-grid-wrap");
  const selected = page.locator(".wb-grid-row td.selected");
  await page.locator('.wb-grid-row td[data-column-index="1"]').first().click();
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const column = async () => Number(await selected.getAttribute("data-column-index"));
  const rowIndex = await selected.getAttribute("data-visual-row-index");
  const row = page.locator(`.wb-grid-row[data-row-selection-index="${rowIndex}"]`);
  const totalWidth = await wrap.evaluate((el) => el.scrollWidth);
  for (let index = 2; index < 60; index += 1) {
    await page.keyboard.press("ArrowRight");
    await frame();
    assert.equal(await column(), index);
    const visible = await selected.evaluate((el) => {
      const cell = el.getBoundingClientRect();
      const viewport = el.closest(".wb-grid-wrap").getBoundingClientRect();
      return cell.left >= viewport.left && cell.left < viewport.right && cell.right <= viewport.right + 2;
    });
    assert.ok(visible, `column ${index} should remain visible`);
  }
  assert.ok(await page.locator(".wb-col-spacer").count());
  assert.ok(await row.locator("td[data-column-index]").count() < 20);
  assert.ok(Math.abs(await wrap.evaluate((el) => el.scrollWidth) - totalWidth) <= 2, "horizontal extent must not change");
  const original = await selected.innerText();
  await page.keyboard.press("Enter");
  const editor = page.locator("td.editing input");
  await editor.fill("column-window-regression");
  await editor.press("Enter");
  await page.waitForFunction(() => !document.querySelector("td.pending, td.editing input"));
  assert.equal(await row.locator('td[data-column-index="59"]').innerText(), "column-window-regression");
  await page.keyboard.press("Control+z");
  await page.waitForFunction(({ rowIndex, original }) => document.querySelector(`.wb-grid-row[data-row-selection-index="${rowIndex}"] td[data-column-index="59"]`)?.textContent.trim() === original, { rowIndex, original });
  for (let index = 58; index >= 1; index -= 1) {
    await page.keyboard.press("ArrowLeft");
    await frame();
    assert.equal(await column(), index);
  }
  // Freeze the first two columns and move through the scrolling region.
  await page.getByRole("button", { name: "冻结选项", exact: true }).click();
  await page.getByRole("menuitem", { name: "冻结到当前列", exact: true }).click();
  await frame();
  const frozen = row.locator('td[data-column-index="0"]');
  const frozenLeft = (await frozen.boundingBox()).x;
  for (let index = 0; index < 25; index += 1) await page.keyboard.press("ArrowRight");
  await frame();
  assert.ok(Math.abs((await frozen.boundingBox()).x - frozenLeft) <= 2);
  await frozen.click();
  assert.equal(await column(), 0, "delegation must resolve frozen logical columns");
  // A selection spanning unmounted columns copies all logical values.
  await page.keyboard.press("Shift+Control+ArrowRight");
  await frame();
  await page.keyboard.press("Control+c");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied.trimEnd().split("\t").length, 60);
  const header = page.locator('th[data-column-index="0"]');
  const widthBefore = (await header.boundingBox()).width;
  await header.locator(".wb-col-resize").focus();
  await page.keyboard.press("Shift+ArrowRight");
  await frame();
  const widthAfter = (await header.boundingBox()).width;
  assert.ok(Math.abs(widthAfter - widthBefore - 32) <= 2, "frozen column resize uses the correct rendered cell");
  assert.ok(Math.abs((await frozen.boundingBox()).width - widthAfter) <= 2, "header and data widths agree");
  await page.locator('.wb-grid-row[data-row-selection-index="2"] td[data-column-index="0"]').click();
  await page.getByRole("button", { name: "冻结选项", exact: true }).click();
  await page.getByRole("menuitem", { name: "冻结到当前行", exact: true }).click();
  await wrap.evaluate((el) => { el.scrollTop = 500; el.dispatchEvent(new Event("scroll")); });
  await frame();
  assert.ok(await page.locator(".wb-frozen-row").count(), "frozen data rows must survive virtual scrolling");
  assert.ok(await page.locator(".wb-frozen-row td[data-column-index='0']").count());
  assert.deepEqual(errors, []);
  console.log("Wide-grid navigation, extent, edit/undo, frozen columns and cross-window copy passed.");
} finally {
  await browser.close();
}
