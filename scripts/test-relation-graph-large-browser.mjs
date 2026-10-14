// Large relation graphs in the browser preview: the generated relation lab
// (`?relationLab=<tables>`, 2000 by default) opened on its busiest table.
// Checks that depth switches always change and announce the picture, that
// the layout runs in a worker and settles, and that the canvas keeps the
// ring view's gestures: hover card, right-click pin/unpin without any menu,
// free drag with "restore layout", find, open on click, zoom and fit, the
// whole-database scope and its instant reopening, and Esc order.
// Needs the Vite dev server (the canvas exposes its table positions there).
import assert from "node:assert/strict";
import { join } from "node:path";

import { base, launchBrowser, shots } from "./relation-browser-env.mjs";

const size = Number(process.env.DBSCOUT_RELATION_LAB_SIZE || 2000);
const browser = await launchBrowser();
const errors = [];

const probe = (surface, method, ...args) => surface.evaluate((element, [name, values]) => element.__relationGraph[name](...values), [method, args]);
const resting = (page, scope) => page.waitForFunction(
  (selector) => document.querySelector(selector)?.__relationGraph?.state().running === false,
  `${scope} .wb-relation-graph-surface`,
  { timeout: 60_000 },
);

try {
  // Wide enough that the open sidebar leaves the inspector open.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("dbscout_language", "zh-CN");
    localStorage.setItem("dbscout_sidebar_collapsed", "0");
    localStorage.removeItem("dbscout_relation_graph_options");
    localStorage.removeItem("dbscout_relation_panel_sections");
  });
  await page.goto(`${base}/?relationLab=${size}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator(".wb-source-connection").filter({ hasText: "Demo GameDB" }).getByText("Demo GameDB").first().click();
  await page.locator(".wb-database-item", { hasText: "relation_lab" }).first().click();
  await page.getByRole("group", { name: "relation_lab 的表" }).locator(".wb-table-search input").fill("item");
  await page.locator(".wb-search-result").filter({ has: page.locator(".wb-table-name", { hasText: new RegExp("^item$", "u") }) }).first().click();
  await page.locator('.wb-grid-row td[data-column-index="0"]').first().waitFor();
  await page.getByRole("tab", { name: /^关联/ }).click();

  // The busiest table: far more neighbours than the ring view draws.
  const section = page.locator(".wb-relation-graph-section");
  const surface = section.locator(".wb-relation-graph-surface");
  await surface.waitFor();
  await surface.scrollIntoViewIfNeeded();
  await resting(page, ".wb-relation-graph-section");
  const state = await probe(surface, "state");
  assert.equal(state.worker, true, "the layout runs in a worker");
  const ids = await probe(surface, "ids");
  const depthOne = ids.length;
  assert.ok(depthOne > 60, `depth 1 draws ${depthOne} tables`);
  await section.screenshot({ path: join(shots, "blackcat-relation-graph-large-depth1.png") });

  // Depth 2 adds tables and says how many; depth 1 says what is left.
  await section.locator(".wb-relation-graph-segment button").nth(1).click();
  const notice = section.locator(".wb-relation-graph-notice");
  await notice.waitFor();
  assert.match(await notice.textContent(), /^第 2 层：多了 \d+ 张表，共 \d+ 张$/u);
  const depthTwo = (await probe(surface, "ids")).length;
  assert.ok(depthTwo > depthOne, `depth 2 draws more tables (${depthTwo})`);
  await resting(page, ".wb-relation-graph-section");
  await section.locator(".wb-relation-graph-segment button").nth(0).click();
  await page.waitForFunction(() => /^第 1 层：共 \d+ 张表$/u.test(document.querySelector(".wb-relation-graph-section .wb-relation-graph-notice")?.textContent || ""));
  assert.equal((await probe(surface, "ids")).length, depthOne);
  await resting(page, ".wb-relation-graph-section");

  // Hovering a table shows its card.
  const neighbour = ids.find((id) => id !== "item" && id.startsWith("item_"));
  let point = await probe(surface, "point", neighbour);
  await page.mouse.move(point.x, point.y);
  const card = section.locator(".wb-relation-graph-card");
  await card.waitFor();
  assert.equal((await card.locator("strong").first().textContent()).trim(), neighbour);

  // Right-click pins the card (docked under the narrow graph); right-click again lets go.
  await page.evaluate(() => {
    window.__unhandledMenus = 0;
    document.addEventListener("contextmenu", (event) => { if (!event.defaultPrevented) window.__unhandledMenus += 1; });
  });
  await page.mouse.click(point.x, point.y, { button: "right" });
  await section.locator(".wb-relation-graph-card-dock.is-pinned").waitFor();
  point = await probe(surface, "point", neighbour);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await section.locator(".wb-relation-graph-card.is-pinned").waitFor({ state: "detached" });
  await page.mouse.click(point.x + 3, point.y + 60, { button: "right" });
  assert.equal(await page.evaluate(() => window.__unhandledMenus), 0, "no menu of the app, the WebView or the system");
  assert.equal(await page.locator(".wb-context-menu").count(), 0);

  // A dragged table stays where it is dropped, and only the small tables
  // hanging on it move with it: the rest of the picture neither turns nor
  // shivers. "Restore layout" lets it go.
  const placed = () => surface.evaluate((element) => Object.fromEntries(
    element.__relationGraph.ids().map((id) => [id, element.__relationGraph.point(id)]),
  ));
  const beforeDrag = await placed();
  point = beforeDrag[neighbour];
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 36, point.y + 24, { steps: 10 });
  const duringDrag = await placed();
  await page.mouse.up();
  await resting(page, ".wb-relation-graph-section");
  const afterDrag = await placed();
  const dropped = afterDrag[neighbour];
  assert.ok(Math.abs(dropped.x - point.x - 36) < 1.5 && Math.abs(dropped.y - point.y - 24) < 1.5, "the table stays under the pointer's drop");
  const movedTables = (sample) => Object.keys(beforeDrag).filter((id) => id !== neighbour
    && Math.hypot(sample[id].x - beforeDrag[id].x, sample[id].y - beforeDrag[id].y) > 1);
  assert.ok(movedTables(duringDrag).length <= 5, `only a few tables follow the drag (${movedTables(duringDrag).length})`);
  assert.ok(movedTables(afterDrag).length <= 5, `nothing else moves after the drop (${movedTables(afterDrag).length})`);
  const restore = section.locator(".wb-relation-graph-reset");
  await restore.click();
  await restore.waitFor({ state: "detached" });
  await resting(page, ".wb-relation-graph-section");

  // Find a table: it is brought into view and pinned.
  await section.locator(".wb-relation-graph-find-toggle").click();
  await section.locator(".wb-relation-graph-find input").fill("reward");
  assert.ok(await section.locator(".wb-relation-graph-find-list li").count() >= 1);
  await page.keyboard.press("Enter");
  await section.locator(".wb-relation-graph-card.is-pinned").waitFor();
  assert.equal((await section.locator(".wb-relation-graph-card.is-pinned strong").first().textContent()).trim(), "reward");
  await section.screenshot({ path: join(shots, "blackcat-relation-graph-large-found.png") });
  await section.getByRole("button", { name: "取消固定" }).click();

  // Double-clicking empty space shows everything; the wheel eases in around
  // the pointer, and another double-click fits again.
  const box = await surface.boundingBox();
  await page.mouse.dblclick(box.x + 6, box.y + 6);
  await page.waitForTimeout(800);
  const fitScale = (await probe(surface, "state")).scale;
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(600);
  assert.ok((await probe(surface, "state")).scale > fitScale * 1.5, "zoomed in");
  await page.mouse.dblclick(box.x + 6, box.y + 6);
  await page.waitForTimeout(800);
  assert.ok(Math.abs((await probe(surface, "state")).scale - fitScale) / fitScale < 0.15, "back to the whole picture");

  // Full screen, then the whole database.
  await section.locator(".wb-relation-graph-zoom button").last().click();
  const full = page.locator(".wb-relation-graph-fullscreen");
  await full.waitFor();
  await full.getByRole("button", { name: "整个数据库" }).click();
  await full.locator(".wb-relation-graph-fullscreen-comment").filter({ hasText: /^\d+ 张表 · \d+ 组关系$/u }).waitFor();
  assert.equal(await full.getByRole("button", { name: "2 层" }).count(), 0, "no depth for the whole database");
  await resting(page, ".wb-relation-graph-fullscreen");
  const fullSurface = full.locator(".wb-relation-graph-surface");
  const everything = (await probe(fullSurface, "ids")).length;
  assert.ok(everything > depthTwo, `the whole database (${everything} tables)`);
  await page.screenshot({ path: join(shots, "blackcat-relation-graph-large-database.png") });
  const before = await probe(fullSurface, "point", "reward");

  // "Center on this table" narrows to its neighbourhood; the back button returns.
  point = await probe(fullSurface, "point", neighbour);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await full.getByRole("button", { name: "以此表为中心" }).click();
  await full.locator("#wb-relation-graph-fullscreen-title").filter({ hasText: neighbour }).waitFor();
  await full.getByRole("button", { name: /^回到 item/u }).click();
  await full.locator("#wb-relation-graph-fullscreen-title").filter({ hasText: "item" }).waitFor();

  // Reopening the whole database shows it at once, as it was left.
  await full.getByRole("button", { name: "整个数据库" }).click();
  await page.waitForTimeout(150);
  assert.equal((await probe(fullSurface, "state")).running, false, "no new settling for a picture seen before");
  const again = await probe(fullSurface, "point", "reward");
  assert.ok(Math.hypot(again.x - before.x, again.y - before.y) < 2, "same place as before");

  // Esc lets go of a pin first, then closes.
  point = await probe(fullSurface, "point", neighbour);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await full.locator(".wb-relation-graph-card.is-pinned").waitFor();
  await fullSurface.focus();
  await page.keyboard.press("Escape");
  await full.locator(".wb-relation-graph-card.is-pinned").waitFor({ state: "detached" });
  assert.equal(await full.count(), 1);
  await page.keyboard.press("Escape");
  await full.waitFor({ state: "detached" });

  // A click on a table opens it.
  point = await probe(surface, "point", neighbour);
  await page.mouse.click(point.x, point.y);
  await page.locator(".wb-tab.active .wb-tab-name").filter({ hasText: neighbour }).waitFor();

  assert.deepEqual(errors, []);
  console.log(`Large relation graph: ${depthOne} → ${depthTwo} tables by depth, ${everything} in the whole database; worker layout, notices, pin/unpin without menus, drag and restore, find, zoom and fit, instant reopening and Esc order passed.`);
} finally {
  await browser.close();
}
