// Deleting rows far down a big table: the grid keeps showing the same place.
// It used to fetch the first page again (or the last loaded one, drawn at
// the top) while the scroll position stayed put, so the rows on screen were
// either gone — an empty grid — or someone else's. Seeds 20 000 rows into
// the browser mock, so it needs the Vite dev server
// (`DBSCOUT_GRID_DELETE_TEST_URL`, default http://127.0.0.1:1431).
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.DBSCOUT_GRID_DELETE_TEST_URL || "http://127.0.0.1:1431";
const TOTAL_ROWS = 20_000;
const browser = await chromium.launch({ headless: true });
const errors = [];

// Row numbers and ids of the rows drawn, with the grid's scroll geometry.
const drawn = (page) => page.evaluate(() => {
  const wrap = document.querySelector(".wb-grid-wrap");
  const rows = [...document.querySelectorAll(".wb-grid-row")].map((row) => ({
    number: Number(row.querySelector("td.wb-row-header")?.textContent?.trim()),
    id: Number(row.querySelector('td[data-column-name="id"]')?.textContent?.trim()),
  }));
  return { rows, scrollTop: wrap.scrollTop, scrollHeight: wrap.scrollHeight };
});

async function confirmDelete(page, count) {
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: /删除/ }).last();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await page.locator(".wb-notice").filter({ hasText: `已删除 ${count} 行` }).last().waitFor();
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("dbscout_language", "zh-CN"));
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const itemOption = page.locator('[role="option"]').filter({ hasText: /^item\b/ }).first();
  await itemOption.waitFor();
  await page.evaluate(async (count) => {
    const { rowCache } = await import("/src/workbench/mock/mockRows.js");
    const rows = Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `道具 ${index + 1}`, type: 1, quality: 1, max_stack: 99 }));
    for (const connectionId of ["demo", "demo-staging", "demo-test"]) {
      rowCache.set(`${connectionId}/game_db/item`, rows.map((row) => ({ ...row })));
    }
  }, TOTAL_ROWS);
  await itemOption.dblclick();
  await page.locator('.wb-grid-row td[data-column-name="id"]').first().click();
  // Twice: the first loads the next page, the second reaches its end.
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(1200);
  await page.keyboard.press("Control+End");
  await page.waitForFunction(() => Number(document.querySelector(".wb-grid-row td.selected")?.closest(".wb-grid-row")?.querySelector("td.wb-row-header")?.textContent) > 1500);

  // One row through the row menu (删除行).
  const before = await drawn(page);
  const target = page.locator(".wb-grid-row td.selected").first().locator("xpath=..");
  const targetId = Number((await target.locator('td[data-column-name="id"]').textContent()).trim());
  await target.locator("td.wb-row-header").click({ button: "right" });
  await page.locator(".wb-context-menu").getByText("删除行").click();
  await confirmDelete(page, 1);
  const after = await drawn(page);
  assert.ok(after.rows.length > 20, `rows are drawn after the delete (${after.rows.length})`);
  assert.equal(after.rows[0].number, before.rows[0].number, "the grid shows the same place");
  assert.equal(after.scrollTop, before.scrollTop);
  for (const row of after.rows) {
    assert.equal(row.id, row.number < targetId ? row.number : row.number + 1, `row ${row.number} shows its own data`);
  }
  const rowHeight = (before.scrollHeight - after.scrollHeight);
  assert.ok(rowHeight > 20 && rowHeight < 40, `the table is one row shorter (${rowHeight}px)`);

  // Several rows through the Delete key, picked by row number: a click may
  // scroll the grid a little, so drawn positions are not stable.
  const rowNumbered = (number) => page.locator(".wb-grid-row").filter({
    has: page.locator("td.wb-row-header", { hasText: new RegExp(`^\\s*${number}\\s*$`) }),
  });
  const firstNumber = after.rows[8].number;
  const firstGone = after.rows[8].id;
  await rowNumbered(firstNumber).locator("td.wb-row-header").click();
  await rowNumbered(firstNumber + 3).locator("td.wb-row-header").click({ modifiers: ["Shift"] });
  const beforeRange = await drawn(page);
  await page.keyboard.press("Delete");
  await confirmDelete(page, 4);
  const afterRange = await drawn(page);
  assert.ok(afterRange.rows.length > 20, "rows are still drawn after deleting several");
  const ids = new Set(afterRange.rows.map((row) => row.id));
  for (let id = firstGone; id < firstGone + 4; id += 1) assert.equal(ids.has(id), false, `row ${id} is gone`);
  assert.ok(Math.abs(afterRange.rows[0].number - beforeRange.rows[0].number) <= 30, "the view stays near the deleted rows");
  assert.deepEqual(errors, []);
  console.log(`Grid delete: one row and four rows deleted near row ${before.rows[0].number} of ${TOTAL_ROWS}; the view stayed in place with every row showing its own data.`);
} finally {
  await browser.close();
}
