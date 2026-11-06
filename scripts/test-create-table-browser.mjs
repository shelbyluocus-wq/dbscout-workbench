import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const base = process.env.DBSCOUT_CREATE_TABLE_TEST_URL || "http://127.0.0.1:1431";
const screenshots = process.env.DBSCOUT_CREATE_TABLE_SCREENSHOTS || "/tmp/blackcat-create-table";
await mkdir(screenshots, { recursive: true });
const browserType = process.env.DBSCOUT_BROWSER_ENGINE === "webkit" ? webkit : chromium;
const browser = await browserType.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(15000);
const errors = [];
const layoutWarnings = [];
page.on("pageerror", (error) => {
  if (browserType === webkit && error.message === "ResizeObserver loop completed with undelivered notifications.") {
    layoutWarnings.push(error.message);
  } else {
    errors.push(error.message);
  }
});
await page.addInitScript((theme) => {
  if (sessionStorage.getItem("create-test-seeded")) return;
  sessionStorage.setItem("create-test-seeded", "1");
  localStorage.clear();
  localStorage.setItem("dbscout_language", "zh-CN");
  localStorage.setItem("dbscout_theme", theme);
}, process.env.DBSCOUT_CREATE_TABLE_THEME || "light");
const editor = page.locator(".wb-design-editor");
const home = page.locator(".wb-tab[data-kind='home']");
const menu = page.locator(".wb-dbhome-context-menu");
const name = editor.locator('[name="newTableName"]');

async function createFromBlank() {
  await home.first().click();
  await page.locator(".wb-dbhome-table-surface").click({ button: "right", position: { x: 30, y: 450 } });
  await menu.getByRole("menuitem", { name: "创建表", exact: true }).click();
  await name.waitFor();
}

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator(".wb-dbhome-object-row").first().waitFor();
  await createFromBlank();
  assert.equal(await name.evaluate((element) => element === document.activeElement), true);
  await name.fill("new_rewards");
  await editor.locator('[name="tableComment"]').fill("奖励配置");
  await editor.getByRole("button", { name: "新增字段", exact: true }).click();
  await editor.locator(".wb-design-name-cell input").nth(1).fill("Amount");
  await editor.getByRole("button", { name: "预览并创建", exact: true }).click();
  const confirm = page.getByRole("button", { name: "确认创建空表", exact: true });
  await confirm.waitFor();
  assert.match(await page.locator(".wb-design-sql").textContent(), /CREATE TABLE `game_db`.`new_rewards`/);
  await page.screenshot({ path: `${screenshots}/preview.png` });
  await confirm.click();
  await name.waitFor({ state: "hidden" });
  await editor.locator(".wb-design-grid tbody tr").first().waitFor();
  await home.first().click();
  await page.locator('.wb-dbhome-object-row[data-table-name="new_rewards"]').waitFor();
  await page.locator('.wb-dbhome-object-row[data-table-name="new_rewards"]').dblclick();
  await page.waitForFunction(() => document.querySelector('.wb-tab.active[data-kind="data"] .wb-tab-name')?.textContent === "new_rewards");
  await page.screenshot({ path: `${screenshots}/created.png` });

  await home.first().click();
  await page.locator(".wb-dbhome-object-row").first().click({ button: "right" });
  await menu.getByRole("menuitem", { name: "创建表", exact: true }).click();
  await name.fill("new_rewards");
  await editor.getByRole("button", { name: "预览并创建", exact: true }).click();
  await editor.locator(".wb-design-error", { hasText: "同名" }).waitFor();
  assert.equal(await name.inputValue(), "new_rewards");
  await name.fill("persisted_draft");
  await page.waitForFunction(() => Object.values(localStorage).some((value) => value.includes('"createMode":true') && value.includes('"tableName":"persisted_draft"')));
  await page.setViewportSize({ width: 800, height: 650 });
  await page.screenshot({ path: `${screenshots}/narrow.png` });
  await page.reload({ waitUntil: "domcontentloaded" });
  await name.waitFor();
  assert.equal(await name.inputValue(), "persisted_draft");
  assert.equal(await confirm.count(), 0);
  assert.equal(await editor.locator(".wb-design-name-cell input").first().inputValue(), "ID");
  await page.locator(".wb-tab.active .wb-tab-close").click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(await name.inputValue(), "persisted_draft");
  await page.locator(".wb-tab.active .wb-tab-close").click();
  await page.getByRole("button", { name: "放弃草稿", exact: true }).click();
  await name.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log(`CREATE TABLE BROWSER OK; screenshots: ${screenshots}; existing WebKit ResizeObserver warnings: ${layoutWarnings.length}`);
} catch (error) {
  await page.screenshot({ path: `${screenshots}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
