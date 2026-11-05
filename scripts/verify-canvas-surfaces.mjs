// 补充验证：设计调试面板实时覆盖、上下分屏缺口归属、SQL 工作台表面。
// 用法：先启动 npm run dev（127.0.0.1:1431），再运行本脚本。
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

mkdirSync("output", { recursive: true });

const baseUrl = process.env.DBSCOUT_VERIFY_URL ?? "http://127.0.0.1:1431";
const combinations = [
  ["slate", "light"],
  ["slate", "dark"],
  ["teal", "light"],
  ["teal", "dark"],
  ["azure", "light"],
  ["azure", "dark"],
];

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

async function boot(mode = "dark", colorTheme = "slate") {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(([nextMode, nextColorTheme]) => {
    localStorage.clear();
    localStorage.setItem("dbscout_color_theme", nextColorTheme);
    localStorage.setItem("dbscout_theme", nextMode);
  }, [mode, colorTheme]);
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

  const splitProbe = await page.evaluate(() => {
    const main = document.querySelector(".wb-main");
    const cornerMask = main ? getComputedStyle(main, "::before") : null;
    const outline = main ? getComputedStyle(main, "::after") : null;
    const divider = document.querySelector(".wb-split-layout.is-vertical > .wb-split-divider");
    const dividerMarker = divider ? getComputedStyle(divider, "::before") : null;
    return {
      panes: [...document.querySelectorAll(".wb-workbench-pane")].map((pane) => {
      const tabbar = pane.querySelector(":scope > .wb-pane-tabbar");
      return {
        topEdge: tabbar?.classList.contains("is-top-edge-pane") ?? false,
        leftEdge: tabbar?.classList.contains("is-left-edge-pane") ?? false,
      };
      }),
      cornerMask: cornerMask
        ? {
            content: cornerMask.content,
            backgroundImage: cornerMask.backgroundImage,
          }
        : null,
      outline: outline
        ? {
            content: outline.content,
            borderTopWidth: outline.borderTopWidth,
            borderLeftWidth: outline.borderLeftWidth,
            borderTopLeftRadius: outline.borderTopLeftRadius,
          }
        : null,
      dividerMarker: dividerMarker
        ? {
            content: dividerMarker.content,
            height: dividerMarker.height,
            backgroundColor: dividerMarker.backgroundColor,
          }
        : null,
    };
  });
  assert.equal(splitProbe.panes.length, 2);
  assert.equal(splitProbe.panes.filter((pane) => pane.topEdge).length, 1, "上下分屏只能有一个顶排 pane");
  assert.equal(splitProbe.panes.filter((pane) => pane.leftEdge).length, 2, "上下分屏的两个 pane 都应贴左缘");
  assert.ok(splitProbe.cornerMask, "上下分屏仍应由 wb-main 统一提供左上遮罩");
  assert.notEqual(splitProbe.cornerMask.content, "none");
  assert.match(splitProbe.cornerMask.backgroundImage, /radial-gradient/);
  assert.ok(splitProbe.outline, "上下分屏仍应由 wb-main 统一提供画布描边");
  assert.notEqual(splitProbe.outline.content, "none");
  assert.equal(splitProbe.outline.borderTopWidth, "1px");
  assert.equal(splitProbe.outline.borderLeftWidth, "1px");
  assert.equal(splitProbe.outline.borderTopLeftRadius, "12px");
  assert.ok(splitProbe.dividerMarker, "上下分屏应保留一条内部层级分界线");
  assert.notEqual(splitProbe.dividerMarker.content, "none");
  assert.equal(splitProbe.dividerMarker.height, "1px");
  assert.notEqual(splitProbe.dividerMarker.backgroundColor, "rgba(0, 0, 0, 0)");
  await page.screenshot({ path: "output/layers-vsplit-dark.png" });

  // 六套组合都验证 SQL 外壳属于画布、编辑器属于内容层、结果标签属于 chrome，
  // 同时检查空状态文字在真实背景上的 WCAG AA 对比度。
  for (const [colorTheme, mode] of combinations) {
    await boot(mode, colorTheme);
    await page.getByRole("button", { name: "SQL", exact: true }).click();
    await page.locator(".wb-sql-library").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "新建查询", exact: true }).first().click();
    await page.locator(".wb-sql-workspace").waitFor({ state: "visible" });
    const sqlProbe = await page.evaluate(() => {
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
      const workspace = background(".wb-sql-workspace");
      const emptyText = color(".wb-sql-output-empty");
      return {
        workspace,
        canvas: background(".wb-inspector"),
        toolbar: background(".wb-sql-toolbar"),
        filebar: background(".wb-sql-filebar"),
        editor: background(".wb-sql-editor-pane"),
        output: background(".wb-sql-output"),
        outputTabs: background(".wb-sql-output-tabs"),
        resize: background(".wb-sql-resize"),
        chrome: background(".wb-main"),
        emptyContrast: [asRgb(emptyText), asRgb(workspace)],
      };
    });
    assert.notEqual(sqlProbe.workspace, "(missing)");
    assert.equal(sqlProbe.workspace, sqlProbe.canvas, `${colorTheme}/${mode}: SQL 外壳应属于画布层`);
    assert.equal(sqlProbe.toolbar, sqlProbe.canvas, `${colorTheme}/${mode}: SQL 工具栏应延续画布层`);
    assert.equal(sqlProbe.filebar, sqlProbe.canvas, `${colorTheme}/${mode}: SQL 文件状态条应延续画布层`);
    assert.notEqual(sqlProbe.editor, sqlProbe.canvas, `${colorTheme}/${mode}: SQL 编辑器应保留独立内容层`);
    assert.equal(sqlProbe.output, sqlProbe.canvas, `${colorTheme}/${mode}: SQL 结果外壳应回到画布层`);
    assert.equal(sqlProbe.outputTabs, sqlProbe.chrome, `${colorTheme}/${mode}: SQL 结果标签应属于 chrome 层`);
    assert.equal(sqlProbe.resize, sqlProbe.chrome, `${colorTheme}/${mode}: SQL 分隔拖柄应属于 chrome 层`);
    const emptyContrast = contrastRatio(...sqlProbe.emptyContrast);
    assert.ok(
      emptyContrast >= 4.5,
      `${colorTheme}/${mode}: SQL 空状态文字对比度 ${emptyContrast.toFixed(2)} 未达到 4.5:1`,
    );
    await page.screenshot({ path: `output/layers-sql-${colorTheme}-${mode}.png` });
  }
} finally {
  await browser.close();
}

console.log("PASS: 调试面板、上下分屏与 6 个主题组合的 SQL 工作台层级验证完成。");
