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
const resizeObserverLoopErrors = [];
page.on("pageerror", (error) => {
  if (error.message === "ResizeObserver loop completed with undelivered notifications.") {
    resizeObserverLoopErrors.push(error.message);
    return;
  }
  errors.push(error.message);
});
page.setDefaultTimeout(20_000);
await page.addInitScript(() => {
  if (sessionStorage.getItem("rail-db-test-seeded")) return;
  sessionStorage.setItem("rail-db-test-seeded", "1");
  localStorage.clear();
  localStorage.setItem("dbscout_language", "zh-CN");
  localStorage.setItem("dbscout_sidebar_collapsed", "0");
});

const rail = page.locator(".wb-activity-rail");
const tiles = page.locator(".wb-rail-db-btn");
const slot = page.locator(".wb-rail-db-slot");
const tileMenu = page.locator(".wb-rail-db-menu");
const popover = page.locator(".wb-rail-db-popover");
const tip = page.locator(".wb-rail-db-tip");

function dbRow(name) {
  return page.locator(".wb-database-item").filter({ has: page.getByText(name, { exact: true }) });
}

function tile(name) {
  return page.locator(`.wb-rail-db-btn[data-wb-rail-database="${name}"]`);
}

const lastPointer = { x: 0, y: 0 };

async function moveTo(x, y, steps = 8) {
  const from = { x: lastPointer.x, y: lastPointer.y };
  for (let index = 1; index <= steps; index += 1) {
    await page.mouse.move(from.x + (x - from.x) * (index / steps), from.y + (y - from.y) * (index / steps), { steps: 1 });
    await page.waitForTimeout(30);
  }
  lastPointer.x = x;
  lastPointer.y = y;
}

async function dragDatabaseToRail(name) {
  const row = dbRow(name).first();
  const rowBox = await row.boundingBox();
  assert.ok(rowBox, `sidebar row for ${name}`);
  const railBox = await rail.boundingBox();
  const start = { x: rowBox.x + rowBox.width / 2, y: rowBox.y + rowBox.height / 2 };
  lastPointer.x = start.x;
  lastPointer.y = start.y;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await moveTo(start.x + 12, start.y + 6, 6);
  await slot.waitFor();
  await moveTo(railBox.x + railBox.width / 2, railBox.y + railBox.height / 2, 10);
  await page.locator(".wb-rail-db-slot.is-hover").waitFor();
  await page.mouse.up();
}

async function settle() {
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => {
      const timing = animation.effect?.getComputedTiming?.() || {};
      return timing.iterations === Infinity
        || animation.playState === "finished"
        || animation.playState === "idle";
    }),
    undefined,
    { timeout: 5000 },
  ).catch(() => {});
  await page.waitForTimeout(400);
}

async function expectInsidePopover(selector) {
  const popBox = await popover.boundingBox();
  assert.ok(popBox, "popover box");
  const boxes = await popover.locator(selector).evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, bottom: rect.bottom };
  }));
  assert.ok(boxes.length > 0, `${selector} present`);
  const popRight = popBox.x + popBox.width;
  const popBottom = popBox.y + popBox.height;
  for (const box of boxes) {
    assert.ok(
      box.left >= popBox.x - 0.5
      && box.right <= popRight + 0.5
      && box.bottom <= popBottom + 0.5,
      `${selector} escapes popover: ${JSON.stringify(box)} vs ${JSON.stringify(popBox)}`,
    );
  }
}

async function sawIsNew(locator) {
  return locator.evaluate((node) => new Promise((resolve) => {
    if (node.classList.contains("is-new")) return resolve(true);
    const observer = new MutationObserver(() => {
      if (node.classList.contains("is-new")) {
        observer.disconnect();
        resolve(true);
      }
    });
    observer.observe(node, { attributes: true, attributeFilter: ["class"] });
    setTimeout(() => { observer.disconnect(); resolve(false); }, 300);
  }));
}

try {
  await page.goto(`${base}?relationLab=50`, { waitUntil: "domcontentloaded" });
  await page.locator(".wb-tab[data-kind='home']").first().waitFor();
  await page.locator(".wb-connection-node").filter({ hasText: "Demo GameDB" }).click();
  await dbRow("relation_lab").first().waitFor();

  assert.equal(await tiles.count(), 0);
  assert.equal(await slot.count(), 0);

  const firstRow = dbRow("game_config").first();
  const firstRowBox = await firstRow.boundingBox();
  const railBox = await rail.boundingBox();
  const startPoint = { x: firstRowBox.x + firstRowBox.width / 2, y: firstRowBox.y + firstRowBox.height / 2 };
  lastPointer.x = startPoint.x;
  lastPointer.y = startPoint.y;
  await page.mouse.move(startPoint.x, startPoint.y);
  await page.mouse.down();
  await moveTo(startPoint.x + 12, startPoint.y + 6, 6);
  await slot.waitFor();
  await moveTo(railBox.x + railBox.width / 2, railBox.y + railBox.height / 2, 10);
  await page.locator(".wb-rail-db-slot.is-hover").waitFor();
  await page.screenshot({ path: `${screenshots}/rail-db-drop-slot.png` });
  await page.mouse.up();
  await tile("game_config").waitFor();
  assert.equal(await tile("game_config").getAttribute("aria-label"), "game_config");
  assert.equal(await sawIsNew(tile("game_config")), true, "new tile plays the entrance flag");

  await dragDatabaseToRail("relation_lab");
  await tile("relation_lab").waitFor();
  assert.equal(await tiles.count(), 2);
  const colors = await page.locator(".wb-rail-db-tile").evaluateAll(
    (nodes) => nodes.map((node) => getComputedStyle(node).getPropertyValue("--wb-rail-db-color").trim()),
  );
  assert.equal(colors.length, 2);
  assert.notEqual(colors[0], colors[1]);

  await tile("game_config").click();
  await page.locator(".wb-database-item.active").filter({ hasText: "game_config" }).waitFor();
  assert.equal(await page.locator(".wb-tab.active[data-kind='home']").count() >= 1, true);
  assert.equal(await tile("game_config").getAttribute("aria-current"), "true");
  await page.waitForFunction(() => document.querySelectorAll(".wb-table-branch").length === 0);

  await dbRow("game_config").first().click();
  await page.locator(".wb-table-branch").first().waitFor();
  await tile("relation_lab").click();
  await page.locator(".wb-database-item.active").filter({ hasText: "relation_lab" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".wb-table-branch").length === 0);

  await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + 10, { steps: 4 });
  await page.waitForTimeout(200);
  await tile("relation_lab").hover();
  await tip.waitFor();
  await page.waitForTimeout(500);
  assert.match(await tip.textContent(), /relation_lab/);
  await settle();
  await page.screenshot({ path: `${screenshots}/rail-db-tip.png` });

  await tile("relation_lab").click({ button: "right" });
  await tileMenu.waitFor();
  await tileMenu.getByRole("menuitem", { name: "更换图标…" }).click();
  await popover.waitFor();
  await expectInsidePopover(".wb-database-color-swatch");

  await popover.getByRole("button", { name: "图标", exact: true }).click();
  await popover.locator(".wb-rail-db-icon-grid button").first().waitFor();
  await expectInsidePopover(".wb-database-color-swatch");
  await expectInsidePopover(".wb-rail-db-icon-grid button");
  await popover.getByRole("button", { name: "火箭", exact: true }).click();
  assert.equal(await tile("relation_lab").locator("svg").count() >= 1, true);
  await settle();
  await page.screenshot({ path: `${screenshots}/rail-db-popover-icons.png` });

  await popover.getByRole("button", { name: "文字", exact: true }).click();
  await page.waitForFunction(
    () => document
      .querySelector('.wb-rail-db-btn[data-wb-rail-database="relation_lab"] .wb-rail-db-tile-text')
      ?.textContent?.trim() === "RL",
  );
  assert.equal(await tile("relation_lab").locator("svg").count(), 0);

  const textInput = popover.getByRole("textbox", { name: "显示文字" });
  await textInput.fill("AB");
  await page.waitForFunction(
    () => document
      .querySelector('.wb-rail-db-btn[data-wb-rail-database="relation_lab"] .wb-rail-db-tile-text')
      ?.textContent?.trim() === "AB",
  );

  const imeResult = await page.evaluate(() => {
    const input = document.querySelector(".wb-rail-db-popover input[type='text']");
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "cesh";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, data: "h" }));
    const duringValue = input.value;
    input.value = "测试服";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "测试服" }));
    return { duringValue, afterValue: input.value };
  });
  assert.equal(imeResult.duringValue, "cesh");
  assert.equal(imeResult.afterValue, "测试");
  await page.waitForFunction(
    () => document
      .querySelector('.wb-rail-db-btn[data-wb-rail-database="relation_lab"] .wb-rail-db-tile-text')
      ?.textContent?.trim() === "测试",
  );
  await textInput.fill("AB");

  const beforeColor = await tile("relation_lab").locator(".wb-rail-db-tile").evaluate(
    (node) => getComputedStyle(node).getPropertyValue("--wb-rail-db-color").trim(),
  );
  await popover.locator("button.wb-database-color-swatch:not(.wb-database-color-theme)[aria-pressed='false']").first().click();
  const afterColor = await tile("relation_lab").locator(".wb-rail-db-tile").evaluate(
    (node) => getComputedStyle(node).getPropertyValue("--wb-rail-db-color").trim(),
  );
  assert.notEqual(afterColor, beforeColor);
  await settle();
  await page.screenshot({ path: `${screenshots}/rail-db-popover.png` });

  await popover.getByRole("button", { name: "图标", exact: true }).click();
  await popover.getByRole("button", { name: "火箭", exact: true }).click();
  assert.equal(await tile("relation_lab").locator("svg").count() >= 1, true);
  await popover.getByRole("button", { name: "文字", exact: true }).click();
  await page.waitForFunction(
    () => document
      .querySelector('.wb-rail-db-btn[data-wb-rail-database="relation_lab"] .wb-rail-db-tile-text')
      ?.textContent?.trim() === "RL",
  );

  await popover.locator("button.wb-database-color-swatch[aria-pressed='true']").first().click();
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "detached" });
  assert.equal(await popover.count(), 0);
  assert.equal(await tile("relation_lab").evaluate((node) => document.activeElement === node), true);

  await tile("relation_lab").click({ button: "right" });
  await tileMenu.waitFor();
  await tileMenu.hover();
  await page.keyboard.press("Escape");
  await tileMenu.waitFor({ state: "detached" });
  assert.equal(await tile("relation_lab").evaluate((node) => document.activeElement === node), true);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".wb-tab[data-kind='home']").first().waitFor();
  await tile("relation_lab").waitFor();
  assert.equal(await tiles.count(), 2);
  assert.equal((await tile("relation_lab").locator(".wb-rail-db-tile-text").textContent()).trim(), "RL");
  assert.equal(await tile("relation_lab").locator(".wb-rail-db-tile").evaluate(
    (node) => getComputedStyle(node).getPropertyValue("--wb-rail-db-color").trim(),
  ), afterColor);

  await page.locator('[data-wb-rail-id="databaseFavorites"]').click();
  const panel = page.locator(".wb-home-favorites-panel");
  await panel.waitFor();
  const panelRows = panel.locator(".wb-home-favorite-item");
  assert.equal(await panelRows.count(), 2);
  const configRow = panelRows.filter({ hasText: "game_config" });
  await configRow.locator(".wb-home-favorite-rail").click();
  await tile("game_config").waitFor({ state: "detached" });
  assert.equal(await tile("game_config").count(), 0);
  assert.equal(await panelRows.count(), 2);
  await configRow.locator(".wb-home-favorite-rail").click();
  await tile("game_config").waitFor();
  await page.locator(".wb-tab[data-kind='home']").first().click();
  await panel.waitFor({ state: "detached" });

  await dbRow("game_db").first().click({ button: "right" });
  const sidebarMenu = page.locator(".wb-context-menu").first();
  await sidebarMenu.waitFor();
  await sidebarMenu.getByRole("menuitem", { name: "固定到入口栏", exact: true }).click();
  await tile("game_db").waitFor();
  assert.equal(await tiles.count(), 3);
  await tile("game_db").click({ button: "right" });
  await tileMenu.waitFor();
  await tileMenu.getByRole("menuitem", { name: "从入口栏移除", exact: true }).click();
  await tile("game_db").waitFor({ state: "detached" });
  assert.equal(await tiles.count(), 2);
  await page.locator('[data-wb-rail-id="databaseFavorites"]').click();
  await panel.waitFor();
  assert.equal(await panel.locator(".wb-home-favorite-item").count(), 3);
  await page.locator(".wb-tab[data-kind='home']").first().click();
  await panel.waitFor({ state: "detached" });

  await settle();
  await page.screenshot({ path: `${screenshots}/rail-db-light.png`, clip: { x: 0, y: 0, width: 460, height: 820 } });

  await page.evaluate(() => localStorage.setItem("dbscout_theme", "dark"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await tile("relation_lab").waitFor();
  const rowsVisible = await page.locator(".wb-database-item").first()
    .waitFor({ state: "visible", timeout: 2000 }).then(() => true).catch(() => false);
  if (!rowsVisible) {
    await page.locator(".wb-connection-node").filter({ hasText: "Demo GameDB" }).click();
    await page.locator(".wb-database-item").first().waitFor();
  }
  await settle();
  await page.screenshot({ path: `${screenshots}/rail-db-dark.png`, clip: { x: 0, y: 0, width: 460, height: 820 } });

  const dimReport = await page.evaluate(() => {
    const label = document.querySelector(".wb-tree-label");
    const chain = [];
    let node = label;
    while (node && chain.length < 8) {
      const style = getComputedStyle(node);
      chain.push({
        cls: String(node.className?.baseVal ?? node.className ?? "").slice(0, 70),
        color: style.color,
        opacity: style.opacity,
        filter: style.filter,
        visibility: style.visibility,
      });
      node = node.parentElement;
    }
    return chain;
  });
  console.log("dark sidebar label styles:", JSON.stringify(dimReport));

  const darkRailBox = await rail.boundingBox();
  await page.mouse.move(darkRailBox.x + darkRailBox.width / 2, darkRailBox.y + 10, { steps: 4 });
  await page.waitForTimeout(200);
  await tile("relation_lab").hover();
  await tip.waitFor();
  await page.waitForTimeout(500);
  assert.match(await tip.textContent(), /relation_lab/);
  await settle();
  await page.screenshot({ path: `${screenshots}/rail-db-dark-tip.png` });

  await tile("relation_lab").click({ button: "right" });
  await tileMenu.waitFor();
  await tileMenu.getByRole("menuitem", { name: "更换图标…" }).click();
  await popover.waitFor();
  await popover.getByRole("button", { name: "图标", exact: true }).click();
  await popover.locator(".wb-rail-db-icon-grid button").first().waitFor();
  await settle();
  await page.screenshot({ path: `${screenshots}/rail-db-dark-popover.png` });
  await popover.getByRole("button", { name: "火箭", exact: true }).click();
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "detached" });
  assert.equal(await tile("relation_lab").evaluate((node) => document.activeElement === node), true);
} finally {
  if (resizeObserverLoopErrors.length) {
    console.log(`pre-existing ResizeObserver loop pageerrors seen (WebKit): ${resizeObserverLoopErrors.length}`);
  }
  if (errors.length) console.error("pageerrors:", errors);
  assert.deepEqual(errors, []);
  await browser.close();
}

console.log("rail databases browser test passed");
