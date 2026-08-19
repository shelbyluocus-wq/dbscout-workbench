// 冒烟：批量导入对比里每张表都有全屏入口，进入后只看该表，退出后回到多表叠放。
import { chromium } from "playwright";
import * as XLSX from "xlsx";

const BASE = `http://127.0.0.1:${process.env.SMOKE_PORT || 1431}/`;
const screenshotDir = "output";

const browser = await chromium.launch({
  headless: true,
  ...(process.env.SMOKE_BROWSER_CHANNEL ? { channel: process.env.SMOKE_BROWSER_CHANNEL } : {}),
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

function buildImportBuffer() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name", "rarity", "element", "hp_base", "atk_base", "def_base", "spd_base", "skill_id", "is_available", "description"],
      ["1", "全屏改名英雄", "5", "火", "1000", "100", "50", "110", "1001", "1", "hero fullscreen"],
      ["999991", "全屏新增英雄", "4", "水", "900", "90", "40", "105", "1002", "1", "hero insert"],
    ]),
    "hero",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name", "type", "quality", "max_stack", "expire_days", "is_tradable", "description"],
      ["1", "全屏改名道具", "1", "5", "999", "0", "1", "item fullscreen"],
      ["999992", "全屏新增道具", "2", "3", "99", "0", "1", "item insert"],
    ]),
    "item",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name", "type", "cooldown", "mp_cost", "damage_rate", "target_type", "unlock_level", "max_level", "description"],
      ["1", "全屏改名技能", "1", "8", "20", "1.5", "1", "1", "5", "skill fullscreen"],
      ["999993", "全屏新增技能", "1", "6", "15", "1.2", "1", "1", "5", "skill insert"],
    ]),
    "skill",
  );
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);

  const homeRow = page.locator('.wb-dbhome-object-row[data-table-name="hero"]').first();
  if (!(await homeRow.isVisible().catch(() => false))) {
    await page.locator(".wb-tree-row.wb-database-item").first().dblclick();
    await page.waitForTimeout(800);
  }

  await page.locator('button[aria-label="批量导入"]').first().click();
  const dialog = page.locator(".wb-batch-transfer-dialog");
  await dialog.waitFor({ timeout: 5000 });

  await page.locator('input[type="file"]').setInputFiles({
    name: "verify-table-fullscreen.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: buildImportBuffer(),
  });
  await page.waitForTimeout(1400);

  for (const tableName of ["hero", "item", "skill"]) {
    const row = dialog.locator(".wb-batch-transfer-row", { hasText: tableName }).first();
    await row.waitFor({ timeout: 5000 });
    if ((await row.locator("select").inputValue()) !== tableName) {
      await row.locator("select").selectOption(tableName);
    }
    const checkbox = row.locator('input[type="checkbox"]');
    if (!(await checkbox.isChecked())) await checkbox.click();
  }

  await dialog.locator(".wb-batch-compare-action").click();
  const comparison = page.locator(".wb-batch-comparison");
  await comparison.locator(".wb-batch-diff-section-expand").first().waitFor({ timeout: 20000 });

  const expandButtons = comparison.locator(".wb-batch-diff-section-expand");
  const sectionCount = await comparison.locator(".wb-batch-diff-section").count();
  const expandCount = await expandButtons.count();
  console.log("stacked tables:", sectionCount, "expand buttons:", expandCount);
  if (sectionCount < 2) fail(`expected multiple stacked tables, got ${sectionCount}`);
  if (expandCount !== sectionCount) fail(`each table should have a fullscreen entry (${expandCount}/${sectionCount})`);

  await page.screenshot({ path: `${screenshotDir}/verify-table-fullscreen-stacked.png` });

  const firstLabel = await expandButtons.first().getAttribute("aria-label");
  console.log("first expand label:", firstLabel);
  if (!firstLabel?.startsWith("全屏查看")) fail(`unexpected expand label: ${firstLabel}`);

  await expandButtons.nth(1).click();
  await page.waitForTimeout(250);
  const afterOpen = await page.evaluate(() => {
    const root = document.querySelector(".wb-batch-comparison");
    return {
      tableStage: root?.classList.contains("is-table-stage"),
      globalFullscreen: root?.classList.contains("is-fullscreen"),
      sections: document.querySelectorAll(".wb-batch-diff-section").length,
      tableName: document.querySelector(".wb-table-stage-identity strong")?.textContent || "",
      summary: Boolean(document.querySelector(".wb-batch-comparison-summary")),
      tableNav: Boolean(document.querySelector(".wb-batch-comparison-tables")),
      back: document.querySelector(".wb-table-stage-back")?.textContent?.trim() || "",
      rootOpen: document.documentElement.classList.contains("wb-comparison-fullscreen-open"),
    };
  });
  console.log("after table stage:", afterOpen);
  if (!afterOpen.tableStage) fail("did not enter the dedicated table comparison");
  if (afterOpen.globalFullscreen) fail("table comparison reused the outer fullscreen chrome");
  if (afterOpen.sections !== 1) fail(`table comparison did not isolate one table, got ${afterOpen.sections}`);
  if (!afterOpen.tableName) fail("table comparison is missing the table name");
  if (afterOpen.summary) fail("table comparison still shows the batch summary strip");
  if (afterOpen.tableNav) fail("table comparison still shows the table list");
  if (afterOpen.back !== "返回全部表") fail(`expected 返回全部表, got ${afterOpen.back}`);
  if (!afterOpen.rootOpen) fail("document did not lock scroll for the table comparison");
  if (!(await comparison.locator(".wb-batch-diff-body").first().isVisible())) {
    fail("table comparison did not reveal the isolated table rows");
  }
  const openedName = afterOpen.tableName;
  await comparison.getByRole("button", { name: "下一张表" }).click();
  await page.waitForTimeout(200);
  const switchedName = await comparison.locator(".wb-table-stage-identity > strong").textContent();
  console.log("switched table:", openedName, "->", switchedName);
  if (!switchedName || switchedName.trim() === openedName) fail("next-table did not change the focused table");

  await page.screenshot({ path: `${screenshotDir}/verify-table-fullscreen-open.png` });

  await comparison.getByRole("button", { name: "返回全部表" }).click();
  await page.waitForTimeout(250);
  const afterExit = await page.evaluate(() => ({
    tableStage: document.querySelector(".wb-batch-comparison")?.classList.contains("is-table-stage"),
    sections: document.querySelectorAll(".wb-batch-diff-section").length,
  }));
  console.log("after table exit:", afterExit);
  if (afterExit.tableStage) fail("table comparison did not return to the stacked view");
  if (afterExit.sections < 2) fail("exiting table comparison did not restore all tables");

  await expandButtons.first().click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const afterEsc = await page.evaluate(() => ({
    tableStage: document.querySelector(".wb-batch-comparison")?.classList.contains("is-table-stage"),
    sections: document.querySelectorAll(".wb-batch-diff-section").length,
  }));
  console.log("after Escape:", afterEsc);
  if (afterEsc.tableStage) fail("Escape did not leave the table comparison");
  if (afterEsc.sections < 2) fail("Escape did not restore the stacked comparison");

  await page.screenshot({ path: `${screenshotDir}/verify-table-fullscreen-restored.png` });
} catch (error) {
  fail(error?.message || String(error));
  await page.screenshot({ path: `${screenshotDir}/verify-table-fullscreen-error.png` }).catch(() => {});
} finally {
  await browser.close();
}

console.log(process.exitCode ? "VERIFY FAILED" : "VERIFY OK");
