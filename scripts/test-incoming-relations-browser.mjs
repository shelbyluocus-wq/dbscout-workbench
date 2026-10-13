import assert from "node:assert/strict";
import { chromium } from "playwright";
import { join } from "node:path";
import { tmpdir } from "node:os";

const base = process.env.DBSCOUT_RELATIONS_TEST_URL || "http://127.0.0.1:1431";
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("dbscout_language", "zh-CN"));
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('[role="option"]').filter({ hasText: /^skill\b/ }).waitFor();
  // Seed this isolated browser's mock data; no real database is connected.
  await page.evaluate(async () => {
    const { rowCache } = await import("/src/workbench/mock/mockRows.js");
    for (const connectionId of ["demo", "demo-staging", "demo-test"]) {
      rowCache.set(`${connectionId}/game_db/hero`, [
        ...Array.from({ length: 125 }, (_, index) => ({ id: String(index + 1), skill_id: "1" })),
        { id: "1001", skill_id: "2" },
      ]);
    }
  });
  await page.locator('[role="option"]').filter({ hasText: /^skill\b/ }).dblclick();
  const cells = page.locator('.wb-grid-row td[data-column-index="0"]');
  await cells.first().click();
  await page.getByRole("tab", { name: /^关联/ }).click();
  const panel = page.locator(".wb-relations-panel");
  await page.waitForFunction(() => !document.querySelector(".wb-relations-panel")?.textContent.includes("正在分析客户端代码"));
  const card = panel.locator(".wb-incoming-relation").filter({ hasText: "hero.skill_id" });
  await card.waitFor();
  assert.equal(await card.locator(".wb-incoming-key").count(), 0, "details start collapsed");
  await card.locator(".wb-incoming-toggle").click();
  await card.locator(".wb-incoming-key").first().waitFor();
  const labels = await card.locator(".wb-incoming-key").allTextContents();
  assert.equal(labels.length, 50);
  assert.ok(labels.every((label) => /^id=\d+$/.test(label)));
  await card.locator(".wb-incoming-toggle").click();
  assert.equal(await card.locator(".wb-incoming-details").count(), 0);
  await card.locator(".wb-incoming-toggle").focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await card.locator(".wb-incoming-key").allTextContents(), labels, "warm expansion retains keys");
  await card.getByRole("button", { name: "加载更多", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".wb-incoming-key").length === 100);
  await card.getByRole("button", { name: "加载更多", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".wb-incoming-key").length === 125);
  assert.equal(await card.getByRole("button", { name: "加载更多", exact: true }).count(), 0);
  assert.equal(new Set(await card.locator(".wb-incoming-key").allTextContents()).size, 125);
  await page.screenshot({ path: join(tmpdir(), "blackcat-incoming-relations.png") });
  await cells.nth(1).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".wb-incoming-relation")].some((element) => element.textContent.includes("hero.skill_id") && element.textContent.includes("1 行")));
  assert.equal(await card.locator(".wb-incoming-details").count(), 0, "changing the row clears the expanded details");
  await card.locator(".wb-incoming-toggle").click();
  await card.getByRole("button", { name: "id=1001", exact: true }).waitFor();
  const key = "1001";
  await card.locator(".wb-incoming-key").first().click();
  await page.waitForFunction((key) => {
    const cell = document.querySelector('.wb-grid-row td[data-column-index="0"].selected');
    return cell?.textContent.trim() === key;
  }, key);
  assert.equal(await page.locator('.wb-grid-row td[data-column-index="0"]').first().innerText(), key);
  assert.deepEqual(errors, []);
  console.log("Incoming references: cold/warm expansion, keyboard toggle, 125-row paging, selection reset, and primary-key jump passed.");
} finally {
  await browser.close();
}
