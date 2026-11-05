// Table folders end to end in the browser preview: favorites migrate into the
// favorites folder, folders are created, renamed, filled from tables and from
// other folders, opened here and in a new window (a browser tab in the
// preview), and deleted. The folder window must not touch the main window's
// saved tabs.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.DBSCOUT_TABLE_FOLDERS_TEST_URL || "http://127.0.0.1:1431";
const screenshots = process.env.DBSCOUT_TABLE_FOLDERS_SCREENSHOTS || "output/playwright";
await mkdir(screenshots, { recursive: true });

const browser = await chromium.launch({ headless: true, ...(process.env.DBSCOUT_BROWSER_CHANNEL ? { channel: process.env.DBSCOUT_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(15_000);
await page.addInitScript(() => {
  if (sessionStorage.getItem("folders-test-seeded")) return;
  sessionStorage.setItem("folders-test-seeded", "1");
  localStorage.clear();
  localStorage.setItem("dbscout_language", "zh-TW");
});

const dialog = page.locator(".wb-table-folder-dialog");
const folderItems = dialog.locator(".wb-table-folder-list .wb-table-folder-item");
const folderRows = dialog.locator(".wb-table-folder-rows .wb-table-folder-row");

async function folderTableNames() {
  return folderRows.locator(".wb-table-folder-table").allTextContents();
}

async function dataTabNames(target) {
  return target.locator(".wb-tab .wb-tab-name").evaluateAll((elements) => elements.map((el) => el.textContent.trim()).filter(Boolean));
}

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const rows = page.locator(".wb-dbhome-object-row");
  await rows.nth(2).waitFor();
  const names = await rows.evaluateAll((elements) => elements.slice(0, 3).map((row) => row.dataset.tableName));
  assert.equal(names.length, 3);

  // The star still favorites tables; they land in the favorites folder.
  // Favorites move to the top of the list, so star by name.
  for (const name of names.slice(0, 2)) {
    await page.locator(`.wb-dbhome-object-row[data-table-name="${name}"] .wb-dbhome-favorite-button`).click();
  }

  await page.locator('[data-wb-rail-id="tableFolders"]').click();
  await dialog.waitFor();
  assert.equal((await folderItems.first().textContent()).includes("收藏"), true);
  assert.deepEqual((await folderTableNames()).sort(), names.slice(0, 2).sort());

  // New folder starts renaming with a suggested name.
  await dialog.getByRole("button", { name: "新增資料夾" }).click();
  const rename = dialog.locator(".wb-table-folder-rename");
  await rename.waitFor();
  assert.equal(await rename.inputValue(), "新資料夾");
  await rename.fill("英雄養成");
  await rename.press("Enter");
  assert.equal(await dialog.locator(".wb-table-folder-heading strong").textContent(), "英雄養成");
  assert.match(await dialog.locator(".wb-table-folder-empty").textContent(), /還沒有表/);

  // Add one table by picking it.
  await dialog.getByRole("button", { name: "加入表" }).click();
  await dialog.locator(".wb-table-folder-search input").fill(names[2]);
  await dialog.locator(".wb-table-folder-picker .wb-table-folder-row", { hasText: names[2] }).first().click();
  await dialog.getByRole("button", { name: "加入 1 張" }).click();
  assert.deepEqual(await folderTableNames(), [names[2]]);

  // Add the favorites folder's tables: a snapshot of what it holds now.
  await dialog.getByRole("button", { name: "加入資料夾的表" }).click();
  await dialog.locator(".wb-table-folder-import-menu").getByRole("menuitem", { name: /收藏/ }).click();
  assert.deepEqual((await folderTableNames()).sort(), [...names].sort());
  await page.locator(".wb-operation-notice, [class*='notice']", { hasText: "已加入 2 張表" }).first().waitFor();
  await dialog.screenshot({ path: `${screenshots}/table-folders-dialog.png`, animations: "disabled" });

  // Duplicate names are refused while renaming.
  await dialog.locator(".wb-table-folder-sidebar").getByRole("button", { name: "新增資料夾" }).click();
  await rename.fill("英雄養成");
  await rename.press("Enter");
  assert.match(await dialog.locator(".wb-table-folder-error").textContent(), /同名/);
  await rename.fill("活動");
  await rename.press("Enter");
  assert.equal(await folderItems.count(), 3);

  // Delete the empty folder after confirming.
  await dialog.getByRole("button", { name: "刪除資料夾" }).click();
  const confirm = page.locator(".wb-confirm-dialog");
  await confirm.waitFor();
  await confirm.getByRole("button", { name: "刪除資料夾" }).click();
  assert.equal(await folderItems.count(), 2);

  // Open the folder in a new window. The main window's saved tabs stay as they were.
  await folderItems.nth(1).click();
  const savedBefore = await page.evaluate(() => localStorage.getItem("dbscout_workspace"));
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    dialog.getByRole("button", { name: "在新視窗開啟" }).click(),
  ]);
  popup.on("pageerror", (error) => errors.push(`popup: ${error.message}`));
  await popup.waitForLoadState("domcontentloaded");
  assert.match(popup.url(), /tableFolder=fld-/);
  await popup.locator(".wb-tab .wb-tab-name", { hasText: names[2] }).first().waitFor();
  await popup.waitForFunction((expected) => {
    const tabs = [...document.querySelectorAll(".wb-tab .wb-tab-name")].map((el) => el.textContent.trim());
    return expected.every((name) => tabs.includes(name));
  }, names);
  assert.equal(await popup.title(), "英雄養成 - Blackcat");
  // The first folder table is the one shown.
  assert.equal((await popup.locator(".wb-tab.active .wb-tab-name").textContent()).trim(), names[2]);
  await popup.screenshot({ path: `${screenshots}/table-folders-window.png`, animations: "disabled" });
  await popup.waitForTimeout(600);
  assert.equal(await page.evaluate(() => localStorage.getItem("dbscout_workspace")), savedBefore);
  assert.equal(await dialog.count(), 0, "the page closes once the window opened");

  // Folders edited in the folder window show up in the main window.
  await popup.locator('[data-wb-rail-id="tableFolders"]').click();
  const popupDialog = popup.locator(".wb-table-folder-dialog");
  await popupDialog.waitFor();
  await popupDialog.locator(".wb-table-folder-sidebar").getByRole("button", { name: "新增資料夾" }).click();
  await popupDialog.locator(".wb-table-folder-rename").fill("從視窗建立");
  await popupDialog.locator(".wb-table-folder-rename").press("Enter");
  await popup.keyboard.press("Escape");
  await popup.close();

  await page.locator('[data-wb-rail-id="tableFolders"]').click();
  await dialog.waitFor();
  await dialog.locator(".wb-table-folder-item", { hasText: "從視窗建立" }).waitFor();

  // Open here: every folder table becomes a tab of this window.
  await dialog.locator(".wb-table-folder-item", { hasText: "英雄養成" }).click();
  await dialog.getByRole("button", { name: "在此視窗開啟" }).click();
  await page.waitForFunction((expected) => {
    const tabs = [...document.querySelectorAll(".wb-tab .wb-tab-name")].map((el) => el.textContent.trim());
    return expected.every((name) => tabs.includes(name));
  }, names);

  // Removing a table from a folder never touches the table.
  await page.locator('[data-wb-rail-id="tableFolders"]').click();
  await dialog.locator(".wb-table-folder-item", { hasText: "英雄養成" }).click();
  const first = folderRows.first();
  await first.hover();
  await first.locator(".wb-table-folder-icon-button").click();
  assert.equal(await folderRows.count(), 2);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 0);

  assert.deepEqual(errors, []);
  console.log("table folders browser test passed");
} catch (error) {
  await page.screenshot({ path: `${screenshots}/table-folders-failure.png` }).catch(() => {});
  console.error("page errors:", errors);
  throw error;
} finally {
  await browser.close();
}
