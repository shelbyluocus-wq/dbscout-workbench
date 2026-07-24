// 内嵌画布分层验证：3 套配色 × 明暗模式截图，并校验区域 1 / 区域 2 的真实计算样式。
// 用法：先启动 npm run dev（127.0.0.1:1431），再运行本脚本。
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

mkdirSync("output", { recursive: true });

const combinations = [
  ["slate", "light"],
  ["slate", "dark"],
  ["teal", "light"],
  ["teal", "dark"],
  ["azure", "light"],
  ["azure", "dark"],
];
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

async function openFirstTable() {
  const row = page.locator(".wb-tree-row.wb-table-item:visible").first();
  assert.ok(await row.count(), "mock 数据应至少渲染一张可见表");
  await row.dblclick();
  await page.locator(".wb-grid").first().waitFor({ state: "visible" });
}

async function boot(colorTheme, mode) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(([nextColorTheme, nextMode]) => {
    localStorage.clear();
    localStorage.setItem("dbscout_color_theme", nextColorTheme);
    localStorage.setItem("dbscout_theme", nextMode);
  }, [colorTheme, mode]);
  await page.reload({ waitUntil: "networkidle" });
  await ensureSidebarExpanded();
  await openFirstTable();
}

try {
  for (const [colorTheme, mode] of combinations) {
    await boot(colorTheme, mode);

    const probe = await page.evaluate(() => {
      const background = (selector) => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element).backgroundColor : "(missing)";
      };
      const pane = document.querySelector(
        ".wb-workbench-pane:has(> .wb-pane-tabbar.is-left-edge-pane.is-top-edge-pane)",
      );
      const notch = pane ? getComputedStyle(pane, "::after") : null;
      return {
        sidebar: background(".wb-sidebar"),
        titlebarTabs: background(".wb-titlebar-tabs"),
        paneTabbar: background(".wb-pane-tabbar"),
        mainFrame: background(".wb-main"),
        gridCanvas: background(".wb-grid-shell"),
        gridRow: background(".wb-grid tr.wb-grid-row td:not(.wb-row-index)"),
        inspector: background(".wb-inspector"),
        gridHeader: background(".wb-grid th:not(.wb-row-index)"),
        rowIndex: background(".wb-grid .wb-row-index"),
        notch: notch
          ? {
              content: notch.content,
              top: notch.top,
              left: notch.left,
              width: notch.width,
              height: notch.height,
              backgroundImage: notch.backgroundImage,
            }
          : null,
      };
    });

    assert.notEqual(probe.sidebar, "(missing)");
    assert.equal(probe.titlebarTabs, probe.sidebar, `${colorTheme}/${mode}: 标题栏应属于区域 1`);
    assert.equal(probe.paneTabbar, probe.sidebar, `${colorTheme}/${mode}: 页签条应属于区域 1`);
    assert.equal(probe.mainFrame, probe.sidebar, `${colorTheme}/${mode}: 主工作区外框应属于区域 1`);
    assert.equal(probe.inspector, probe.gridRow, `${colorTheme}/${mode}: 检查器应属于区域 2`);
    assert.equal(probe.gridCanvas, probe.gridRow, `${colorTheme}/${mode}: 网格空区应与数据行同属画布`);
    assert.notEqual(probe.gridHeader, probe.gridRow, `${colorTheme}/${mode}: 表头需保留表内层次`);
    assert.notEqual(probe.rowIndex, probe.gridRow, `${colorTheme}/${mode}: 行号列需保留表内层次`);
    assert.ok(probe.notch, `${colorTheme}/${mode}: 应找到左上画布缺口`);
    assert.notEqual(probe.notch.content, "none");
    assert.equal(probe.notch.top, "40px");
    assert.equal(probe.notch.left, "0px");
    assert.equal(probe.notch.width, "12px");
    assert.equal(probe.notch.height, "12px");
    assert.match(probe.notch.backgroundImage, /radial-gradient/);

    console.log(`\n=== ${colorTheme} / ${mode} ===`);
    console.log(JSON.stringify(probe, null, 2));
    await page.screenshot({ path: `output/layers-${colorTheme}-${mode}.png` });
  }
} finally {
  await browser.close();
}

console.log("\nPASS: 6 个主题组合的区域分层与左上缺口均符合预期。");
