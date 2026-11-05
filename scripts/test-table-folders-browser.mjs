// Table folders end to end in the browser preview: the page opens as a tab,
// favorites are its first folder, folders are created with the + icon,
// filled through the table picker and by dragging (sidebar tables, folder
// onto folder), renamed and deleted from the right-click menu, opened in a
// new window (a browser tab in the preview) and restored with the tab.
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
page.setDefaultTimeout(20_000);
await page.addInitScript(() => {
  if (sessionStorage.getItem("folders-test-seeded")) return;
  sessionStorage.setItem("folders-test-seeded", "1");
  localStorage.clear();
  localStorage.setItem("dbscout_language", "zh-TW");
});

const folderPage = page.locator(".wb-folder-page");
const folderItems = folderPage.locator(".wb-folder-list .wb-folder-item");
const folderRows = folderPage.locator(".wb-folder-content .wb-folder-row");
const menu = page.locator(".wb-folder-menu");

function folder(name) {
  return folderPage.locator(".wb-folder-list .wb-folder-item", { hasText: name });
}

async function folderTableNames() {
  return folderRows.locator(".wb-folder-table").allTextContents();
}

async function waitForNotice(text) {
  await page.getByText(text).first().waitFor();
}

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const rows = page.locator(".wb-dbhome-object-row");
  await rows.nth(3).waitFor();
  const names = await rows.evaluateAll((elements) => elements.slice(0, 4).map((row) => row.dataset.tableName));

  // The home star still favorites tables: they land in the favorites folder.
  for (const name of names.slice(0, 2)) {
    await page.locator(`.wb-dbhome-object-row[data-table-name="${name}"] .wb-dbhome-favorite-button`).click();
  }

  // The rail opens the folder page as a tab of this database.
  await page.locator('[data-wb-rail-id="tableFolders"]').click();
  await folderPage.waitFor();
  assert.equal((await page.locator(".wb-tab.active .wb-tab-name").textContent()).trim(), "表格資料夾");
  assert.match(await folderItems.first().textContent(), /收藏/);
  assert.deepEqual((await folderTableNames()).sort(), names.slice(0, 2).sort());
  // A clean page: no counts, no footer, no visible rename/delete buttons.
  assert.equal(await folderPage.locator(".wb-folder-item small").count(), 0);
  assert.equal(await folderPage.getByRole("button", { name: /重新命名|刪除/ }).count(), 0);

  // + creates a folder and starts naming it.
  await folderPage.locator(".wb-folder-add").click();
  const rename = folderPage.locator(".wb-folder-rename");
  await rename.waitFor();
  assert.equal(await rename.inputValue(), "新資料夾");
  await rename.fill("英雄養成");
  await rename.press("Enter");
  assert.equal(await folderPage.locator(".wb-folder-header h2").textContent(), "英雄養成");
  assert.match(await folderPage.locator(".wb-folder-empty").textContent(), /拖到這裡/);

  // Add tables: pick, then submit.
  await folderPage.getByRole("button", { name: "添加表" }).click();
  const picker = folderPage.locator(".wb-folder-picker");
  await picker.waitFor();
  await picker.locator(".wb-folder-search input").fill(names[2]);
  await picker.locator(".wb-folder-row", { hasText: names[2] }).first().click();
  await picker.getByRole("button", { name: "提交（1）" }).click();
  assert.deepEqual(await folderTableNames(), [names[2]]);

  // Drag the favorites folder onto it: its tables join.
  await folder("收藏").dragTo(folder("英雄養成"));
  await waitForNotice("已加入 2 張表到「英雄養成」");
  assert.deepEqual((await folderTableNames()).sort(), names.slice(0, 3).sort());

  // Drag a table from the sidebar onto the folder.
  const sidebarTable = page.locator(`.wb-table-item[data-table-name="${names[3]}"]`);
  if (!(await sidebarTable.isVisible())) await page.getByRole("button", { name: "展開資料庫欄" }).click();
  await sidebarTable.waitFor();
  await sidebarTable.scrollIntoViewIfNeeded();
  await sidebarTable.dragTo(folder("英雄養成"));
  await waitForNotice("已加入 1 張表到「英雄養成」");
  assert.deepEqual((await folderTableNames()).sort(), [...names].sort());
  await folderPage.screenshot({ path: `${screenshots}/table-folders-page.png`, animations: "disabled" });

  // Rename and delete live in the folder's right-click menu.
  await folderPage.locator(".wb-folder-add").click();
  await rename.fill("活動");
  await rename.press("Enter");
  await folder("活動").click({ button: "right" });
  await menu.waitFor();
  await page.screenshot({ path: `${screenshots}/table-folders-menu.png`, animations: "disabled" });
  await menu.getByRole("menuitem", { name: /重新命名/ }).click();
  await rename.fill("英雄養成");
  await rename.press("Enter");
  assert.match(await folderPage.locator(".wb-folder-error").textContent(), /同名/);
  await rename.fill("活動二");
  await rename.press("Enter");
  await folder("活動二").click({ button: "right" });
  await menu.getByRole("menuitem", { name: /刪除/ }).click();
  const confirm = page.locator(".wb-confirm-dialog");
  await confirm.waitFor();
  await confirm.getByRole("button", { name: "刪除資料夾" }).click();
  assert.equal(await folderItems.count(), 2);
  // Favorites offer no rename or delete.
  await folder("收藏").click({ button: "right" });
  assert.equal(await menu.getByRole("menuitem", { name: /重新命名|刪除/ }).count(), 0);
  await page.keyboard.press("Escape");

  // Remove a table from the folder through its menu.
  await folder("英雄養成").click();
  await folderRows.first().click({ button: "right" });
  await menu.getByRole("menuitem", { name: /從資料夾移除/ }).click();
  assert.equal(await folderRows.count(), 3);
  const kept = await folderTableNames();

  // Open in a new window. The main window's saved tabs stay as they were.
  await page.waitForTimeout(500);
  const savedBefore = await page.evaluate(() => localStorage.getItem("dbscout_workspace"));
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    folderPage.getByRole("button", { name: "在新視窗開啟" }).click(),
  ]);
  popup.on("pageerror", (error) => errors.push(`popup: ${error.message}`));
  await popup.waitForLoadState("domcontentloaded");
  assert.match(popup.url(), /tableFolder=fld-/);
  await popup.waitForFunction((expected) => {
    const tabs = [...document.querySelectorAll(".wb-tab .wb-tab-name")].map((el) => el.textContent.trim());
    return expected.every((name) => tabs.includes(name));
  }, kept);
  assert.equal(await popup.title(), "英雄養成 - Blackcat");
  assert.equal((await popup.locator(".wb-tab.active .wb-tab-name").textContent()).trim(), kept[0]);
  await popup.screenshot({ path: `${screenshots}/table-folders-window.png`, animations: "disabled" });
  await popup.waitForTimeout(600);
  await popup.close();
  assert.equal(await page.evaluate(() => localStorage.getItem("dbscout_workspace")), savedBefore);

  // The folder page comes back with the workspace, on the same folder.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".wb-tab", { hasText: "表格資料夾" }).click();
  await folderPage.waitFor();
  assert.equal(await folderPage.locator(".wb-folder-header h2").textContent(), "英雄養成");

  assert.deepEqual(errors, []);
  console.log("table folders browser test passed");
} catch (error) {
  await page.screenshot({ path: `${screenshots}/table-folders-failure.png` }).catch(() => {});
  console.error("page errors:", errors);
  throw error;
} finally {
  await browser.close();
}
