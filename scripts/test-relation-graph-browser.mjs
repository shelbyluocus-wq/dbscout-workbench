import assert from "node:assert/strict";
import { chromium } from "playwright";
import { join } from "node:path";
import { tmpdir } from "node:os";

const base = process.env.DBSCOUT_RELATIONS_TEST_URL || "http://127.0.0.1:1431";
const shots = process.env.DBSCOUT_RELATIONS_SCREENSHOTS || tmpdir();
// e.g. "msedge" or "chrome" to use an installed browser instead of Playwright's.
const channel = process.env.DBSCOUT_PLAYWRIGHT_CHANNEL || undefined;
const browser = await chromium.launch({ headless: true, channel });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("dbscout_language", "zh-CN");
    localStorage.removeItem("dbscout_relation_graph_options");
  });
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const itemRow = page.locator('[role="option"]').filter({ hasText: /^item\b/ });
  await itemRow.waitFor();
  await itemRow.dblclick();
  await page.locator('.wb-grid-row td[data-column-index="0"]').first().waitFor();
  await page.getByRole("tab", { name: "关联", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".wb-relations-panel")?.textContent.includes("正在分析客户端代码"));

  const graph = page.locator(".wb-relation-graph");
  const nodes = graph.locator(".wb-relation-graph-node");
  await nodes.first().waitFor();
  const depthOne = await nodes.count();
  assert.ok(depthOne > 1, "the current table and its neighbours are drawn");
  assert.equal(await graph.locator(".wb-relation-graph-node.is-center").count(), 1);
  assert.ok(await graph.locator(".wb-relation-graph-link").count() >= depthOne - 1);
  await graph.screenshot({ path: join(shots, "blackcat-relation-graph-depth1.png") });

  // Hovering a neighbour keeps its own neighbourhood bright.
  const neighbour = graph.locator(".wb-relation-graph-node:not(.is-center)").first();
  await neighbour.locator("circle").hover();
  await page.waitForFunction(() => document.querySelector(".wb-relation-graph.is-hovering"));
  assert.equal(await graph.locator(".wb-relation-graph-node.is-hovered").count(), 1);

  const section = page.locator(".wb-relation-graph-section");
  await section.getByRole("button", { name: "2 层", exact: true }).click();
  await page.waitForFunction((count) => document.querySelectorAll(".wb-relation-graph-node").length > count, depthOne);
  await page.locator(".wb-relations-panel").screenshot({ path: join(shots, "blackcat-relation-graph-depth2.png") });

  const depthTwo = await nodes.count();
  await section.getByRole("button", { name: "被谁引用", exact: true }).click();
  await page.waitForFunction((count) => document.querySelectorAll(".wb-relation-graph-node").length < count, depthTwo);
  const locked = section.getByRole("button", { name: "引用的表", exact: true });
  assert.equal(await locked.getAttribute("aria-disabled"), "true", "the last direction cannot be turned off");
  await section.getByRole("button", { name: "被谁引用", exact: true }).click();

  // Settings persist across reloads.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("dbscout_relation_graph_options")));
  assert.deepEqual(saved, { collapsed: false, depth: 2, outgoing: true, incoming: true, height: 260 });

  // The wheel zooms without a modifier; the fit button glides back.
  const canvas = graph.locator(".wb-relation-graph-canvas");
  const before = await canvas.getAttribute("viewBox");
  await canvas.hover({ position: { x: 40, y: 40 } });
  await page.mouse.wheel(0, -300);
  await page.waitForFunction((box) => document.querySelector(".wb-relation-graph-canvas")?.getAttribute("viewBox") !== box, before);
  await graph.getByRole("button", { name: "适应大小", exact: true }).click();
  await page.waitForFunction((box) => document.querySelector(".wb-relation-graph-canvas")?.getAttribute("viewBox") === box, before);

  // Dragging a table moves it, drags its neighbours along, and it swings back
  // after release without opening the table.
  const activeTab = await page.locator(".wb-tab.active").textContent();
  const dragged = graph.locator(".wb-relation-graph-node:not(.is-center)").first();
  const rest = await dragged.getAttribute("transform");
  const centerRest = await graph.locator(".wb-relation-graph-node.is-center").getAttribute("transform");
  const box = await dragged.locator("circle").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 45, { steps: 8 });
  await page.waitForTimeout(300);
  assert.notEqual(await dragged.getAttribute("transform"), rest, "the dragged table follows the pointer");
  assert.equal(await graph.locator(".wb-relation-graph.is-dragging, .wb-relation-graph-node.is-dragged").count() > 0, true);
  assert.notEqual(await graph.locator(".wb-relation-graph-node.is-center").getAttribute("transform"), centerRest, "neighbours are pulled along");
  await page.locator(".wb-relations-panel").screenshot({ path: join(shots, "blackcat-relation-graph-drag.png") });
  await page.mouse.up();
  await page.waitForFunction((value) =>
    document.querySelector(".wb-relation-graph-node:not(.is-center)")?.getAttribute("transform") === value, rest, { timeout: 5_000 })
    .catch(() => {});
  const settled = (await dragged.getAttribute("transform")).match(/-?[\d.]+/g).map(Number);
  const home = rest.match(/-?[\d.]+/g).map(Number);
  assert.ok(Math.hypot(settled[0] - home[0], settled[1] - home[1]) < 2, "the table swings back to its place");
  assert.equal(await page.locator(".wb-tab.active").textContent(), activeTab, "a drag does not open the table");

  // The bottom edge resizes the graph and the height is remembered.
  const resizeHandle = graph.locator(".wb-relation-graph-resize");
  const handleBox = await resizeHandle.boundingBox();
  const heightBefore = (await graph.boundingBox()).height;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 100, { steps: 5 });
  await page.mouse.up();
  const heightAfter = (await graph.boundingBox()).height;
  assert.ok(heightAfter > heightBefore + 80, `graph grew from ${heightBefore} to ${heightAfter}`);
  const resized = await page.evaluate(() => JSON.parse(localStorage.getItem("dbscout_relation_graph_options")));
  assert.ok(resized.height >= 340, `height ${resized.height} is stored`);

  // The enlarged view shows the same graph and closes with Esc.
  const inlineCount = await nodes.count();
  await graph.getByRole("button", { name: "放大查看", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator(".wb-relation-graph-node").first().waitFor();
  assert.equal(await dialog.locator(".wb-relation-graph-node").count(), inlineCount);
  await page.screenshot({ path: join(shots, "blackcat-relation-graph-expanded.png") });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  // Clicking a neighbour opens that table.
  const target = graph.locator(".wb-relation-graph-node:not(.is-center)").first();
  const label = (await target.getAttribute("aria-label")).split(" · ")[0];
  await target.locator("circle").click();
  await page.waitForFunction((name) =>
    document.querySelector(".wb-tab.active")?.textContent.includes(name), label);

  // Dark theme keeps the picture readable.
  await page.evaluate(() => document.querySelector(".mysql-workbench")?.setAttribute("data-theme", "dark"));
  await graph.locator(".wb-relation-graph-node").first().waitFor();
  await page.locator(".wb-relation-graph-section").screenshot({ path: join(shots, "blackcat-relation-graph-dark.png") });

  await section.getByRole("button", { name: "收起关系图", exact: true }).click();
  assert.equal(await graph.count(), 0);
  assert.deepEqual(errors, []);
  console.log(`Relation graph: ${depthOne} tables at depth 1, depth/direction toggles, persistence, zoom, open-on-click and collapse passed.`);
} finally {
  await browser.close();
}
