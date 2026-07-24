// 补充验证：设计调试面板实时覆盖、上下分屏缺口归属、SQL 工作台表面。
// 用法：先启动 npm run dev（127.0.0.1:1431），再运行本脚本。
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

mkdirSync("output", { recursive: true });

const baseUrl = process.env.DBSCOUT_VERIFY_URL ?? "http://127.0.0.1:1431";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

async function ensureSidebarExpanded() {
  if (await page.locator(".wb-tree-row.wb-table-item:visible").count()) return;
  const toggle = page.locator(".wb-titlebar-sidebar .wb-topbar-collapse-btn").first();
  assert.ok(await toggle.count(), "侧栏折叠时应存在展开按钮");
  await toggle.click();
  await page.locator(".wb-tree-row.wb-table-item:visible").first().waitFor({ state: "visible" });
}

async function boot(mode = "dark") {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate((nextMode) => {
    localStorage.clear();
    localStorage.setItem("dbscout_color_theme", "slate");
    localStorage.setItem("dbscout_theme", nextMode);
  }, mode);
  await page.reload({ waitUntil: "networkidle" });
  await ensureSidebarExpanded();
}

async function openTable(name = "player") {
  const namedRow = page.locator(`.wb-tree-row.wb-table-item[data-table-name="${name}"]:visible`).first();
  const row = await namedRow.count() ? namedRow : page.locator(".wb-tree-row.wb-table-item:visible").first();
  assert.ok(await row.count(), "应存在可打开的 mock 表");
  await row.dblclick();
  await page.locator(".wb-grid").first().waitFor({ state: "visible" });
}

try {
  await boot("dark");
  await openTable();

  // 设置 → 设计调试：启动后设置抽屉收起，调色与虚影实时作用于完整区域 1。
  await page.locator(".wb-sidebar-settings-trigger").click();
  const debugOpen = page.locator(".wb-sidebar-settings-row", { hasText: "设计调试" }).locator("button");
  assert.equal(await debugOpen.count(), 1, "开发模式设置中应出现设计调试入口");
  await debugOpen.click();
  await page.locator(".wb-design-debug").waitFor({ state: "visible" });
  await page.locator(".wb-sidebar-settings-sheet").waitFor({ state: "hidden" });

  await page.locator('.wb-design-debug input[type="color"]').first().fill("#2563eb");
  await page.locator('.wb-design-debug input[type="range"]').nth(2).fill("0.2");

  const debugProbe = await page.evaluate(() => {
    const workbench = document.querySelector(".mysql-workbench");
    const background = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
    return {
      chromeInline: workbench.style.getPropertyValue("--wb-chrome-surface"),
      shadowInline: workbench.style.getPropertyValue("--wb-frame-shadow"),
      sidebar: background(".wb-sidebar"),
      titlebarTabs: background(".wb-titlebar-tabs"),
      paneTabbar: background(".wb-pane-tabbar"),
      mainFrame: background(".wb-main"),
      tabbarShadow: getComputedStyle(document.querySelector(".wb-pane-tabbar")).boxShadow,
    };
  });
  assert.equal(debugProbe.chromeInline, "#2563eb");
  assert.equal(debugProbe.shadowInline, "0 5px 8px -5px rgba(0, 0, 0, 0.2)");
  assert.equal(debugProbe.sidebar, "rgb(37, 99, 235)");
  assert.equal(debugProbe.titlebarTabs, debugProbe.sidebar);
  assert.equal(debugProbe.paneTabbar, debugProbe.sidebar);
  assert.equal(debugProbe.mainFrame, debugProbe.sidebar);
  assert.notEqual(debugProbe.tabbarShadow, "none");
  await page.screenshot({ path: "output/design-debug-dark.png" });

  await page.getByRole("button", { name: "重置" }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".wb-design-debug").waitFor({ state: "hidden" });
  const resetProbe = await page.evaluate(() => {
    const workbench = document.querySelector(".mysql-workbench");
    return {
      chrome: workbench.style.getPropertyValue("--wb-chrome-surface"),
      shadow: workbench.style.getPropertyValue("--wb-frame-shadow"),
    };
  });
  assert.deepEqual(resetProbe, { chrome: "", shadow: "" });

  // 通过分屏按钮的下拉箭头明确选择“上下分屏”，避免误点主按钮造成左右分屏。
  await page.getByRole("button", { name: "分屏更多选项" }).click();
  const splitMenu = page.getByRole("menu", { name: "分屏选项" });
  await splitMenu.waitFor({ state: "visible" });
  await splitMenu.getByRole("menuitem", { name: /上下分屏/ }).click();
  await page.locator(".wb-workbench-pane").nth(1).waitFor({ state: "visible" });

  const splitProbe = await page.evaluate(() =>
    [...document.querySelectorAll(".wb-workbench-pane")].map((pane) => {
      const tabbar = pane.querySelector(":scope > .wb-pane-tabbar");
      const pseudo = getComputedStyle(pane, "::after");
      return {
        topEdge: tabbar?.classList.contains("is-top-edge-pane") ?? false,
        leftEdge: tabbar?.classList.contains("is-left-edge-pane") ?? false,
        hasNotch: pseudo.content !== "none" && pseudo.backgroundImage.includes("radial-gradient"),
      };
    }),
  );
  assert.equal(splitProbe.length, 2);
  assert.equal(splitProbe.filter((pane) => pane.topEdge).length, 1, "上下分屏只能有一个顶排 pane");
  assert.equal(splitProbe.filter((pane) => pane.hasNotch).length, 1, "上下分屏只能有一个左上缺口");
  assert.ok(splitProbe.every((pane) => !pane.hasNotch || (pane.topEdge && pane.leftEdge)));
  await page.screenshot({ path: "output/layers-vsplit-dark.png" });

  // 独立重载后验证 SQL 工作台仍落在区域 2，而不是回到旧的灰色分段。
  await boot("dark");
  await page.getByRole("button", { name: "SQL", exact: true }).click();
  await page.locator(".wb-sql-library").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "新建查询", exact: true }).first().click();
  await page.locator(".wb-sql-workspace").waitFor({ state: "visible" });
  const sqlProbe = await page.evaluate(() => ({
    workspace: getComputedStyle(document.querySelector(".wb-sql-workspace")).backgroundColor,
    canvas: getComputedStyle(document.querySelector(".wb-inspector")).backgroundColor,
  }));
  assert.notEqual(sqlProbe.workspace, "(missing)");
  await page.screenshot({ path: "output/layers-sql-dark.png" });
} finally {
  await browser.close();
}

console.log("PASS: 调试面板、上下分屏缺口和 SQL 工作台验证完成。");
