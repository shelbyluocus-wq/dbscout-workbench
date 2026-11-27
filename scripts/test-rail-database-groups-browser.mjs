// Browser verification for rail database groups: folder tiles, the flyout,
// menus, and light/dark appearance. Run against a Vite dev server:
//   DBSCOUT_BROWSER_CHANNEL=chrome node scripts/test-rail-database-groups-browser.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const base = process.env.DBSCOUT_RAIL_DATABASES_TEST_URL || "http://127.0.0.1:1431";
const screenshots = process.env.DBSCOUT_RAIL_DATABASES_SCREENSHOTS || "output/playwright";
await mkdir(screenshots, { recursive: true });

const browserType = process.env.DBSCOUT_BROWSER_ENGINE === "webkit" ? webkit : chromium;
const browser = await browserType.launch({ headless: true, ...(process.env.DBSCOUT_BROWSER_CHANNEL ? { channel: process.env.DBSCOUT_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(20_000);

// Two rail groups across two mock clusters: 决胜2 配置 (3 databases) and
// 渠道服 (2), plus one loose tile. Group one holds the current database.
await page.addInitScript(() => {
  if (sessionStorage.getItem("rail-group-test-seeded")) return;
  sessionStorage.setItem("rail-group-test-seeded", "1");
  localStorage.clear();
  localStorage.setItem("dbscout_language", "zh-CN");
  localStorage.setItem("dbscout_sidebar_collapsed", "0");
  localStorage.setItem("dbscout_pinned_databases", JSON.stringify([
    { connectionId: "mysql-lab-2", database: "newsg_4cfg", rail: true, railGroup: "rg-testmain" },
    { connectionId: "mysql-lab-2", database: "newsg_4actcfg", rail: true, railGroup: "rg-testmain" },
    { connectionId: "mysql-lab-2", database: "newsg_3cfg", rail: true, railGroup: "rg-testmain" },
    { connectionId: "mysql-lab-1", database: "edota_3cfg", rail: true },
    { connectionId: "mysql-lab-3", database: "dy_main_cfg", rail: true, railGroup: "rg-testchan" },
    { connectionId: "mysql-lab-4", database: "tap_main_cfg", rail: true, railGroup: "rg-testchan" },
  ]));
  localStorage.setItem("dbscout_rail_groups", JSON.stringify([
    { id: "rg-testmain", name: "决胜2 配置" },
    { id: "rg-testchan", name: "渠道服" },
  ]));
});

const folder = (groupId) => page.locator(`.wb-rail-db-group-btn[data-wb-rail-group="${groupId}"]`);
const flyout = page.locator(".wb-rail-db-flyout");
const flyoutRows = page.locator(".wb-rail-db-flyout-row");
const menu = page.locator(".wb-rail-db-menu");

try {
  await page.goto(`${base}?mockConnections=6`, { waitUntil: "domcontentloaded" });
  await page.locator(".wb-tab[data-kind='home']").first().waitFor();

  // Two folder tiles plus one loose tile on the rail.
  await folder("rg-testmain").waitFor();
  await folder("rg-testchan").waitFor();
  await page.locator('.wb-rail-db-btn[data-wb-rail-database="edota_3cfg"]').waitFor();
  assert.equal(await page.locator(".wb-rail-db-group-btn").count(), 2);
  // Folder mosaic cells carry member colors.
  const cellColors = await folder("rg-testmain").locator(".wb-rail-db-folder-cell:not(.is-empty)").evaluateAll(
    (nodes) => nodes.map((node) => getComputedStyle(node).getPropertyValue("--wb-rail-db-color").trim()),
  );
  assert.equal(cellColors.length, 3);
  assert.ok(cellColors.some((color) => color), "mosaic cells have colors");
  await page.screenshot({ path: `${screenshots}/rail-group-light-rail.png` });

  // Clicking the folder opens the flyout with its three databases.
  await folder("rg-testmain").click();
  await flyout.waitFor();
  assert.equal(await flyoutRows.count(), 3);
  assert.ok((await flyout.locator(".wb-rail-db-flyout-name strong").textContent()).includes("决胜2"));
  const names = await flyoutRows.locator(".wb-rail-db-flyout-copy strong").allTextContents();
  assert.deepEqual(names, ["newsg_4cfg", "newsg_4actcfg", "newsg_3cfg"]);
  await page.screenshot({ path: `${screenshots}/rail-group-light-flyout.png` });

  // A flyout row opens its database and closes the flyout.
  await flyoutRows.nth(1).click();
  await page.locator(".wb-database-item.active").filter({ hasText: "newsg_4actcfg" }).waitFor();
  assert.equal(await flyout.count(), 0, "flyout closes after selection");
  // The folder now reads as current.
  assert.equal((await folder("rg-testmain").getAttribute("class")).includes("is-current"), true);

  // The folder menu offers rename and dissolve.
  await folder("rg-testmain").click({ button: "right" });
  await menu.waitFor();
  assert.ok(await menu.getByText("重命名分组").count());
  assert.ok(await menu.getByText("解散分组").count());
  await menu.getByText("重命名分组").click();
  await flyout.waitFor();
  const input = flyout.locator(".wb-rail-db-flyout-name-input");
  await input.waitFor();
  assert.equal(await input.evaluate((node) => node.value), "决胜2 配置");
  await input.fill("决胜2 线上");
  await input.press("Enter");
  await page.waitForTimeout(200);
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem("dbscout_rail_groups")));
  assert.equal(stored.find((group) => group.id === "rg-testmain").name, "决胜2 线上");
  await page.screenshot({ path: `${screenshots}/rail-group-light-renamed.png` });

  // Escape closes the flyout.
  await page.keyboard.press("Escape");
  assert.equal(await flyout.count(), 0);

  // A tile menu offers group actions.
  await page.locator('.wb-rail-db-btn[data-wb-rail-database="edota_3cfg"]').click({ button: "right" });
  await menu.waitFor();
  assert.ok(await menu.getByText("移动到分组…").count());
  await menu.getByText("移动到分组…").click();
  await menu.getByText("渠道服").click();
  await page.waitForTimeout(300);
  // edota_3cfg left the top level; 渠道服 now holds three members.
  assert.equal(await page.locator('.wb-rail-db-btn[data-wb-rail-database="edota_3cfg"]').count(), 0);
  await folder("rg-testchan").click();
  await flyout.waitFor();
  assert.equal(await flyoutRows.count(), 3);
  const pinned = JSON.parse(await page.evaluate(() => localStorage.getItem("dbscout_pinned_databases")));
  assert.equal(pinned.find((entry) => entry.database === "edota_3cfg").railGroup, "rg-testchan");

  // Remove from group puts it back on the rail right after its folder.
  await flyoutRows.filter({ hasText: "edota_3cfg" }).click({ button: "right" });
  await menu.waitFor();
  await menu.getByText("移出分组").click();
  await page.waitForTimeout(300);
  await page.locator('.wb-rail-db-btn[data-wb-rail-database="edota_3cfg"]').waitFor();
  const pinnedAfter = JSON.parse(await page.evaluate(() => localStorage.getItem("dbscout_pinned_databases")));
  assert.equal(pinnedAfter.find((entry) => entry.database === "edota_3cfg").railGroup, undefined);

  // Dissolving 渠道服 returns its members to the rail.
  await page.keyboard.press("Escape");
  await folder("rg-testchan").click({ button: "right" });
  await menu.waitFor();
  await menu.getByText("解散分组").click();
  await page.waitForTimeout(300);
  assert.equal(await folder("rg-testchan").count(), 0);
  await page.locator('.wb-rail-db-btn[data-wb-rail-database="dy_main_cfg"]').waitFor();
  await page.locator('.wb-rail-db-btn[data-wb-rail-database="tap_main_cfg"]').waitFor();
  const groupsAfter = JSON.parse(await page.evaluate(() => localStorage.getItem("dbscout_rail_groups")));
  assert.equal(groupsAfter.some((group) => group.id === "rg-testchan"), false);

  // Dark theme screenshots.
  await page.evaluate(() => localStorage.setItem("dbscout_theme", "dark"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".wb-tab[data-kind='home']").first().waitFor();
  await folder("rg-testmain").waitFor();
  await folder("rg-testmain").click();
  await flyout.waitFor();
  await page.screenshot({ path: `${screenshots}/rail-group-dark-flyout.png` });

  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  console.log("rail database groups browser test passed");
} finally {
  await browser.close();
}
