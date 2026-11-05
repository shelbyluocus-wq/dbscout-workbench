import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, webkit } from "playwright";

const styles = readFileSync(new URL("../src/workbench/workbench.css", import.meta.url), "utf8");

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(`
      <style>${styles}</style>
      <div class="mysql-workbench" data-theme="dark">
        <div style="width: 600px; overflow: auto">
          <table class="wb-grid">
            <thead>
              <tr><th>Kind</th><th>Other</th></tr>
              <tr class="wb-field-comments-row" style="--wb-field-comment-row-height: 32px">
                <th style="width: 70px; min-width: 70px; max-width: 70px">
                  <span class="wb-field-comment-text" style="--wb-field-comment-lines: 1"></span>
                </th>
                <th style="min-width: 1600px">副本名称</th>
              </tr>
            </thead>
            <tbody><tr><td>11</td><td>英雄1阶</td></tr></tbody>
          </table>
        </div>
      </div>
    `);
    const row = page.locator(".wb-field-comments-row");
    const text = page.locator(".wb-field-comment-text");
    for (const height of [32, 48, 96, 32]) {
      await row.evaluate((element, value) => {
        element.style.setProperty("--wb-field-comment-row-height", `${value}px`);
      }, height);
      for (const content of ["副本类型", "副本类型 ID（副本类型表）1 主线，2 精英，3 困难，4 梦境，5 后续参考 Inskindprop。".repeat(30)]) {
        await text.evaluate((element, value) => { element.textContent = value; }, content);
        for (const scrollLeft of [0, 700, 1200, 0]) {
          await row.evaluate((element, offset) => {
            element.closest("table").parentElement.scrollLeft = offset;
          }, scrollLeft);
          const actual = await row.evaluate((element) => element.getBoundingClientRect().height);
          assert.equal(actual, height, `${engine.name()}: comment height at scroll ${scrollLeft}`);
        }
      }
    }
    await row.evaluate((element) => {
      element.classList.add("is-collapsed");
      element.style.setProperty("--wb-field-comment-row-height", "18px");
      for (const cell of element.children) {
        cell.innerHTML = '<span class="wb-field-comment-collapsed-mark"></span>';
      }
    });
    assert.equal(await row.evaluate((element) => element.getBoundingClientRect().height), 18);
    console.log(`${engine.name()}: default, manual heights, long comments, horizontal scroll and collapse passed`);
  } finally {
    await browser.close();
  }
}
