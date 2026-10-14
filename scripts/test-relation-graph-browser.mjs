import assert from "node:assert/strict";
import { join } from "node:path";

import { base, launchBrowser, shots } from "./relation-browser-env.mjs";

const browser = await launchBrowser();
const errors = [];

const translation = (transform) => transform.match(/-?[\d.]+/g).map(Number);
// A card fading out and the next fading in overlap for a moment.
const settledCards = (page) => page.waitForFunction(() =>
  document.querySelectorAll(".wb-relation-graph-section .wb-relation-graph-card").length <= 1);
const distance = (left, right) => Math.hypot(left[0] - right[0], left[1] - right[1]);

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("dbscout_language", "zh-CN");
    localStorage.removeItem("dbscout_relation_graph_options");
    localStorage.removeItem("dbscout_relation_panel_sections");
  });
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const itemRow = page.locator('[role="option"]').filter({ hasText: /^item\b/ });
  await itemRow.waitFor();
  await itemRow.dblclick();
  await page.locator('.wb-grid-row td[data-column-index="0"]').first().waitFor();
  await page.getByRole("tab", { name: /^关联/ }).click();
  await page.waitForFunction(() => !document.querySelector(".wb-relations-panel")?.textContent.includes("正在分析客户端代码"));

  const section = page.locator(".wb-relation-graph-section");
  const graph = section.locator(".wb-relation-graph");
  const nodes = graph.locator(".wb-relation-graph-node");
  await nodes.first().waitFor();
  const depthOne = await nodes.count();
  assert.ok(depthOne > 1, "the current table and its neighbours are drawn");
  assert.equal(await graph.locator(".wb-relation-graph-node.is-center").count(), 1);
  assert.ok(await graph.locator(".wb-relation-graph-link").count() >= depthOne - 1);
  // Names keep clear of every arrowhead.
  await page.waitForTimeout(400);
  const covered = await page.evaluate(() => {
    const svg = document.querySelector(".wb-relations-panel .wb-relation-graph-canvas");
    const labels = [...svg.querySelectorAll(".wb-relation-graph-label")].map((label) => label.getBoundingClientRect());
    const ends = [...svg.querySelectorAll(".wb-relation-graph-link")].flatMap((link) => {
      const length = link.getTotalLength();
      const points = [];
      if (link.getAttribute("marker-end")) points.push(link.getPointAtLength(length));
      if (link.getAttribute("marker-start")) points.push(link.getPointAtLength(0));
      const matrix = link.getScreenCTM();
      return points.map((point) => new DOMPoint(point.x, point.y).matrixTransform(matrix));
    });
    return ends.filter((point) => labels.some((box) => point.x > box.left + 1 && point.x < box.right - 1 && point.y > box.top + 1 && point.y < box.bottom - 1)).length;
  });
  assert.equal(covered, 0, "no arrowhead sits under a table name");
  await graph.screenshot({ path: join(shots, "blackcat-relation-graph-depth1.png") });

  // Hovering a neighbour keeps its own neighbourhood bright.
  const neighbour = graph.locator(".wb-relation-graph-node:not(.is-center)").first();
  await neighbour.locator(".wb-relation-graph-dot").hover();
  await page.waitForFunction(() => document.querySelector(".wb-relation-graph.is-hovering"));
  assert.equal(await graph.locator(".wb-relation-graph-node.is-hovered").count(), 1);
  // The info card names the hovered table and groups its relations by table.
  const hoveredName = (await neighbour.getAttribute("aria-label")).split(" · ")[0];
  const card = section.locator(".wb-relation-graph-card");
  await card.waitFor();
  assert.equal((await card.locator("strong").textContent()).trim(), hoveredName);
  assert.match(await card.textContent(), /(引用 \d+ 张表|被 \d+ 张表引用)/);
  assert.ok(await card.locator(".wb-relation-graph-card-fields code").count() >= 2, "fields name both ends");
  assert.equal(await neighbour.locator("title").count(), 0);
  await graph.screenshot({ path: join(shots, "blackcat-relation-graph-card.png") });

  // Right-click pins the card (docked under the narrow graph); every
  // right-click in the graph is handled without any context menu.
  const centerNode = graph.locator(".wb-relation-graph-node.is-center");
  await centerNode.locator(".wb-relation-graph-dot").click({ button: "right" });
  assert.equal(await graph.locator(".wb-relation-graph-node.is-pinned").count(), 1);
  const pinnedCard = section.locator(".wb-relation-graph-card.is-pinned");
  await pinnedCard.waitFor();
  assert.equal(await section.locator(".wb-relation-graph-card.is-docked").count(), 1, "a narrow graph docks the pinned card");
  assert.ok(await pinnedCard.locator("button.wb-relation-graph-card-table").count() > 0, "other tables can be opened from the card");
  assert.equal(await page.locator(".wb-context-menu").count(), 0, "no menu opens");
  await section.screenshot({ path: join(shots, "blackcat-relation-graph-pinned.png") });
  // Right-clicking another table moves the pin; right-clicking it again lets go.
  await neighbour.locator(".wb-relation-graph-dot").click({ button: "right" });
  await settledCards(page);
  assert.equal((await pinnedCard.locator("strong").textContent()).trim(), hoveredName);
  await neighbour.locator(".wb-relation-graph-dot").click({ button: "right" });
  assert.equal(await graph.locator(".wb-relation-graph-node.is-pinned").count(), 0);
  // A right-click in the card lets go too, and a click on empty space as well.
  await centerNode.locator(".wb-relation-graph-dot").click({ button: "right" });
  await settledCards(page);
  await pinnedCard.click({ button: "right", position: { x: 12, y: 12 } });
  assert.equal(await graph.locator(".wb-relation-graph-node.is-pinned").count(), 0);
  await centerNode.locator(".wb-relation-graph-dot").click({ button: "right" });
  await graph.locator(".wb-relation-graph-canvas").click({ position: { x: 8, y: 8 } });
  assert.equal(await graph.locator(".wb-relation-graph-node.is-pinned").count(), 0);
  const prevented = await page.evaluate(() => {
    const canvas = document.querySelector(".wb-relations-panel .wb-relation-graph-canvas");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 });
    canvas.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(prevented, true, "the WebView menu is suppressed");
  assert.equal(await page.locator(".wb-context-menu").count(), 0);

  // Keyboard: the context-menu key pins a focused table and lets it go again.
  await centerNode.focus();
  await page.keyboard.press("Shift+F10");
  assert.equal(await graph.locator(".wb-relation-graph-node.is-pinned").count(), 1);
  await page.keyboard.press("Shift+F10");
  assert.equal(await graph.locator(".wb-relation-graph-node.is-pinned").count(), 0);
  // Arrow keys move the focused table; "restore layout" brings it back.
  const centerStart = translation(await centerNode.getAttribute("transform"));
  await page.keyboard.press("Shift+ArrowRight");
  assert.ok(translation(await centerNode.getAttribute("transform"))[0] > centerStart[0] + 5, "the table moved right");
  await graph.getByRole("button", { name: "还原自动排列", exact: true }).click();
  await page.waitForTimeout(450);
  assert.ok(distance(translation(await centerNode.getAttribute("transform")), centerStart) < 1);

  await section.getByRole("button", { name: "2 层", exact: true }).click();
  await page.waitForFunction((count) => document.querySelectorAll(".wb-relations-panel .wb-relation-graph-node").length > count, depthOne);
  await page.locator(".wb-relations-panel").screenshot({ path: join(shots, "blackcat-relation-graph-depth2.png") });

  const depthTwo = await nodes.count();
  await section.getByRole("button", { name: "被引用", exact: true }).click();
  await page.waitForFunction((count) => document.querySelectorAll(".wb-relations-panel .wb-relation-graph-node").length < count, depthTwo);
  const locked = section.getByRole("button", { name: "引用", exact: true });
  assert.equal(await locked.getAttribute("aria-disabled"), "true", "the last direction cannot be turned off");
  await section.getByRole("button", { name: "被引用", exact: true }).click();
  await page.waitForFunction((count) => document.querySelectorAll(".wb-relations-panel .wb-relation-graph-node").length === count, depthTwo);

  // Settings persist across reloads.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("dbscout_relation_graph_options")));
  assert.deepEqual(saved, { collapsed: false, depth: 2, outgoing: true, incoming: true, height: 260 });

  // The help button explains the gestures without leaving the graph.
  await graph.locator(".wb-relation-graph-help button").hover();
  const tip = graph.locator(".wb-relation-graph-help-tip");
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".wb-relation-graph-help-tip")).opacity === "1");
  assert.match(await tip.textContent(), /滚轮缩放/);
  await page.mouse.move(0, 0);

  // Circles take the hue of their side of the current table.
  assert.ok(await graph.locator(".wb-relation-graph-node.is-side-in, .wb-relation-graph-node.is-side-out, .wb-relation-graph-node.is-side-both").count() > 0);

  // The wheel zooms without a modifier; the fit button glides back.
  const canvas = graph.locator(".wb-relation-graph-canvas");
  await page.waitForTimeout(400);
  const before = await canvas.getAttribute("viewBox");
  await canvas.hover({ position: { x: 40, y: 40 } });
  await page.mouse.wheel(0, -300);
  await page.waitForFunction((box) => document.querySelector(".wb-relations-panel .wb-relation-graph-canvas")?.getAttribute("viewBox") !== box, before);
  await graph.getByRole("button", { name: "适应大小", exact: true }).click();
  await page.waitForFunction((box) => document.querySelector(".wb-relations-panel .wb-relation-graph-canvas")?.getAttribute("viewBox") === box, before);

  // A dragged table goes where it is dropped and stays; its neighbours stay
  // put, and a drag does not open the table.
  const activeTab = await page.locator(".wb-tab.active").textContent();
  const dragged = graph.locator(".wb-relation-graph-node:not(.is-center)").first();
  const rest = translation(await dragged.getAttribute("transform"));
  const centerRest = await graph.locator(".wb-relation-graph-node.is-center").getAttribute("transform");
  const box = await dragged.locator(".wb-relation-graph-dot").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 45, { steps: 8 });
  await page.waitForTimeout(100);
  assert.equal(await graph.locator(".wb-relation-graph.is-dragging, .wb-relation-graph-node.is-dragged").count() > 0, true);
  assert.ok(distance(translation(await dragged.getAttribute("transform")), rest) > 10, "the dragged table follows the pointer");
  await page.locator(".wb-relations-panel").screenshot({ path: join(shots, "blackcat-relation-graph-drag.png") });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const dropped = translation(await dragged.getAttribute("transform"));
  assert.ok(distance(dropped, rest) > 10, "the table stays where it was dropped");
  assert.equal(await graph.locator(".wb-relation-graph-node.is-center").getAttribute("transform"), centerRest, "neighbours are not pulled along");
  assert.equal(await page.locator(".wb-tab.active").textContent(), activeTab, "a drag does not open the table");
  // "Restore layout" puts it back on the ring.
  const restore = graph.getByRole("button", { name: "还原自动排列", exact: true });
  await restore.click();
  await page.waitForTimeout(500);
  assert.ok(distance(translation(await dragged.getAttribute("transform")), rest) < 1, "the ring layout is back");
  assert.equal(await restore.count(), 0, "nothing left to restore");

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

  // Full screen covers the whole window and shows the same tables.
  const inlineCount = await nodes.count();
  await graph.getByRole("button", { name: "全屏查看", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const fullGraph = page.locator(".wb-relation-graph-fullscreen .wb-relation-graph");
  await fullGraph.locator(".wb-relation-graph-node").first().waitFor();
  assert.equal(await fullGraph.locator(".wb-relation-graph-node").count(), inlineCount);
  await page.evaluate(() => Promise.all(document.querySelector(".wb-relation-graph-fullscreen").getAnimations().map((animation) => animation.finished)));
  const frame = await page.locator(".wb-relation-graph-fullscreen").boundingBox();
  assert.deepEqual([frame.x, frame.y, frame.width, frame.height], [0, 0, 1280, 860], "it fills the window");
  assert.ok(await fullGraph.locator(".wb-relation-graph-comment").count() > 0, "comments show under names");
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, "blackcat-relation-graph-fullscreen.png") });
  // Pin a neighbour and make it the center; one button leads back.
  const fullNeighbour = fullGraph.locator(".wb-relation-graph-node.is-side-in, .wb-relation-graph-node.is-side-out").first();
  const fullName = (await fullNeighbour.getAttribute("aria-label")).split(" · ")[0];
  await fullNeighbour.locator(".wb-relation-graph-dot").click({ button: "right" });
  await fullGraph.locator(".wb-relation-graph-card").getByRole("button", { name: "以此表为中心", exact: true }).click();
  await page.waitForFunction((name) => document.querySelector("#wb-relation-graph-fullscreen-title")?.textContent.includes(name), fullName);
  const back = dialog.getByRole("button", { name: /^回到 item/ });
  await back.click();
  await page.waitForFunction(() => document.querySelector("#wb-relation-graph-fullscreen-title")?.textContent.includes("item"));
  assert.equal(await back.count(), 0);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  // Clicking a neighbour opens that table.
  const target = graph.locator(".wb-relation-graph-node:not(.is-center)").first();
  const label = (await target.getAttribute("aria-label")).split(" · ")[0];
  await target.locator(".wb-relation-graph-dot").click();
  await page.waitForFunction((name) =>
    document.querySelector(".wb-tab.active")?.textContent.includes(name), label);

  // Dark theme keeps the picture readable.
  await page.evaluate(() => document.querySelector(".mysql-workbench")?.setAttribute("data-theme", "dark"));
  await graph.locator(".wb-relation-graph-node").first().waitFor();
  await page.locator(".wb-relation-graph-section").screenshot({ path: join(shots, "blackcat-relation-graph-dark.png") });

  await section.locator(".wb-relation-section-toggle").click();
  assert.equal(await section.locator(".wb-relation-section-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(await graph.count(), 0);
  assert.deepEqual(errors, []);
  console.log(`Relation graph: ${depthOne} tables at depth 1, clear arrowheads, pin/unpin without menus, free drag and restore, full screen with re-centering, persistence and collapse passed.`);
} finally {
  await browser.close();
}
