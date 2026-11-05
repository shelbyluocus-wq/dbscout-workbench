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

function relativeLuminance([red, green, blue]) {
  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

async function ensureSidebarExpanded() {
  if (await page.locator(".wb-tree-row.wb-table-item:visible").count()) return;
  // Table lists start collapsed: open the current database's branch.
  const currentDatabase = page.locator('.wb-database-item[aria-current="true"]').first();
  if (!(await currentDatabase.isVisible())) {
    const toggle = page.locator(".wb-titlebar-sidebar .wb-topbar-collapse-btn").first();
    assert.ok(await toggle.count(), "侧栏折叠时应存在展开按钮");
    await toggle.click();
    await currentDatabase.waitFor({ state: "visible" });
  }
  if ((await currentDatabase.getAttribute("aria-expanded")) !== "true") await currentDatabase.click();
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

    await page.getByRole("button", { name: "分屏更多选项", exact: true }).click();
    const splitMenu = page.getByRole("menu", { name: "分屏选项", exact: true });
    await splitMenu.waitFor({ state: "visible" });
    await splitMenu.getByRole("menuitem", { name: /左右分屏/ }).click();
    await page.locator(".wb-workbench-pane").nth(1).waitFor({ state: "visible" });

    const probe = await page.evaluate(() => {
      const background = (selector) => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element).backgroundColor : "(missing)";
      };
      const color = (selector) => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element).color : "(missing)";
      };
      const asRgb = (value) => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const main = document.querySelector(".wb-main");
      const cornerMask = main ? getComputedStyle(main, "::before") : null;
      const outline = main ? getComputedStyle(main, "::after") : null;
      const divider = document.querySelector(".wb-split-layout.is-horizontal > .wb-split-divider");
      const dividerMarker = divider ? getComputedStyle(divider, "::before") : null;
      const panes = [...document.querySelectorAll(".wb-workbench-pane")].map((pane) => {
        const tabbar = pane.querySelector(":scope > .wb-pane-tabbar");
        return {
          background: getComputedStyle(pane).backgroundColor,
          topEdge: tabbar?.classList.contains("is-top-edge-pane") ?? false,
          leftEdge: tabbar?.classList.contains("is-left-edge-pane") ?? false,
          rightEdge: tabbar?.classList.contains("is-right-edge-pane") ?? false,
        };
      });
      const gridText = color(".wb-grid tr.wb-grid-row td:not(.wb-row-index)");
      const inspectorText = color(".wb-inspector article strong");
      const sidebarText = color(".wb-tree-row.wb-table-item .wb-table-name");
      const gridRow = background(".wb-grid tr.wb-grid-row td:not(.wb-row-index)");
      const inspector = background(".wb-inspector");
      const sidebar = background(".wb-sidebar");
      return {
        sidebar,
        titlebarTabs: background(".wb-titlebar-tabs"),
        paneTabbar: background(".wb-pane-tabbar"),
        mainFrame: background(".wb-main"),
        gridCanvas: background(".wb-grid-shell"),
        gridRow,
        inspector,
        gridHeader: background(".wb-grid th:not(.wb-row-index)"),
        rowIndex: background(".wb-grid .wb-row-index"),
        panes,
        cornerMask: cornerMask
          ? {
              content: cornerMask.content,
              top: cornerMask.top,
              left: cornerMask.left,
              width: cornerMask.width,
              height: cornerMask.height,
              backgroundImage: cornerMask.backgroundImage,
            }
          : null,
        outline: outline
          ? {
              content: outline.content,
              top: outline.top,
              left: outline.left,
              borderTopWidth: outline.borderTopWidth,
              borderLeftWidth: outline.borderLeftWidth,
              borderTopLeftRadius: outline.borderTopLeftRadius,
              pointerEvents: outline.pointerEvents,
            }
          : null,
        dividerMarker: dividerMarker
          ? {
              content: dividerMarker.content,
              top: dividerMarker.top,
              width: dividerMarker.width,
              backgroundColor: dividerMarker.backgroundColor,
            }
          : null,
        contrast: {
          grid: [asRgb(gridText), asRgb(gridRow)],
          inspector: [asRgb(inspectorText), asRgb(inspector)],
          sidebar: [asRgb(sidebarText), asRgb(sidebar)],
        },
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
    assert.equal(probe.panes.length, 2, `${colorTheme}/${mode}: 左右分屏应渲染两个 pane`);
    assert.equal(probe.panes.filter((pane) => pane.topEdge).length, 2);
    assert.equal(probe.panes.filter((pane) => pane.leftEdge).length, 1);
    assert.equal(probe.panes.filter((pane) => pane.rightEdge).length, 1);
    assert.ok(probe.panes.every((pane) => pane.background === probe.gridRow));
    assert.ok(probe.cornerMask, `${colorTheme}/${mode}: 应找到主画布左上角遮罩`);
    assert.notEqual(probe.cornerMask.content, "none");
    assert.equal(probe.cornerMask.top, "39px");
    assert.equal(probe.cornerMask.left, "0px");
    assert.equal(probe.cornerMask.width, "12px");
    assert.equal(probe.cornerMask.height, "12px");
    assert.match(probe.cornerMask.backgroundImage, /radial-gradient/);
    assert.ok(probe.outline, `${colorTheme}/${mode}: 应找到主画布统一描边`);
    assert.notEqual(probe.outline.content, "none");
    assert.equal(probe.outline.top, "39px");
    assert.equal(probe.outline.left, "0px");
    assert.equal(probe.outline.borderTopWidth, "1px");
    assert.equal(probe.outline.borderLeftWidth, "1px");
    assert.equal(probe.outline.borderTopLeftRadius, "12px");
    assert.equal(probe.outline.pointerEvents, "none");
    assert.ok(probe.dividerMarker, `${colorTheme}/${mode}: 应找到左右分屏分界线`);
    assert.notEqual(probe.dividerMarker.content, "none");
    assert.equal(probe.dividerMarker.top, "40px");
    assert.equal(probe.dividerMarker.width, "1px");
    assert.notEqual(probe.dividerMarker.backgroundColor, "rgba(0, 0, 0, 0)");
    for (const [surface, pair] of Object.entries(probe.contrast)) {
      const ratio = contrastRatio(...pair);
      assert.ok(ratio >= 4.5, `${colorTheme}/${mode}: ${surface} 文字对比度 ${ratio.toFixed(2)} 未达到 4.5:1`);
    }

    console.log(`\n=== ${colorTheme} / ${mode} ===`);
    console.log(JSON.stringify(probe, null, 2));
    await page.screenshot({ path: `output/layers-${colorTheme}-${mode}.png` });
  }
} finally {
  await browser.close();
}

console.log("\nPASS: 6 个主题组合的画布层级、统一描边、左右分屏与正文对比度均符合预期。");
