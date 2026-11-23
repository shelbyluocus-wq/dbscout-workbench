import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit } from "playwright";

const base = process.env.DBSCOUT_HOME_COLUMNS_TEST_URL || "http://127.0.0.1:1435";
const screenshotDir = process.env.DBSCOUT_HOME_COLUMNS_SCREENSHOTS || "";
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });

const engines = [
  ["chromium", chromium],
  ["webkit", webkit],
];

for (const [engineName, engine] of engines) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.addInitScript(() => {
      if (sessionStorage.getItem("home-columns-seeded")) return;
      sessionStorage.setItem("home-columns-seeded", "1");
      localStorage.clear();
      localStorage.setItem("dbscout_language", "zh-CN");
      localStorage.setItem("dbscout_sidebar_collapsed", "1");
    });

    await page.goto(base);
    await page.locator(".wb-dbhome-table-header").waitFor({ state: "visible" });

    const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const header = (key) => page.locator(`[data-home-cell-id="header:${key}"]`);
    const resizeHandle = (key) => header(key).locator(".wb-dbhome-resize-handle");
    const box = (locator) => locator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    });

    async function dragHandle(key, deltaX) {
      const handle = resizeHandle(key);
      const rect = await handle.boundingBox();
      assert.ok(rect, `resize handle for ${key} should be visible`);
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + deltaX, y, { steps: 10 });
      await page.mouse.up();
      await frame();
    }

    async function doubleClickHandle(key) {
      const handle = resizeHandle(key);
      const rect = await handle.boundingBox();
      assert.ok(rect, `resize handle for ${key} should be visible`);
      await page.mouse.dblclick(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await frame();
    }

    await frame();
    const surfaceWidth = await page.locator(".wb-dbhome-table-surface").evaluate((el) => el.clientWidth);
    const headerBarWidth = (await box(page.locator(".wb-dbhome-table-header"))).width;
    const firstRowWidth = (await box(page.locator(".wb-dbhome-object-row").first())).width;

    // Header and rows still cover the full pane width for full-row hover/selection.
    assert.ok(headerBarWidth >= surfaceWidth - 1, `${engineName}: header should span pane width`);
    assert.ok(firstRowWidth >= surfaceWidth - 1, `${engineName}: row should span pane width`);

    const defaultWidths = {
      name: Math.round((await box(header("name"))).width),
      size: Math.round((await box(header("size"))).width),
      modified: Math.round((await box(header("modified"))).width),
      comment: Math.round((await box(header("comment"))).width),
    };
    assert.ok(defaultWidths.name >= 156 && defaultWidths.name <= 250, `${engineName}: compact default name width, got ${defaultWidths.name}`);
    assert.equal(defaultWidths.size, 96, `${engineName}: compact default size width`);
    assert.equal(defaultWidths.modified, 160, `${engineName}: compact default modified width`);
    assert.ok(defaultWidths.comment >= 120 && defaultWidths.comment <= 240, `${engineName}: compact default comment width without 1fr stretch, got ${defaultWidths.comment}`);

    // Size and modified headers should not clip their labels at default widths.
    for (const key of ["size", "modified"]) {
      const clipped = await header(key).locator(".wb-dbhome-header-label").evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );
      assert.equal(clipped, false, `${engineName}: ${key} header label should fit cleanly`);
    }

    // Also verify a full YYYY-MM-DD HH:mm:ss timestamp fits inside the default modified column.
    const modifiedCellFit = await page.evaluate(() => {
      const cell = document.querySelector(".wb-dbhome-object-cell:not(.wb-dbhome-object-comment):not(.is-end)");
      if (!cell) return null;
      const probe = document.createElement("span");
      probe.textContent = "2026-11-23 17:59:51";
      probe.style.cssText = "position:fixed;visibility:hidden;white-space:nowrap;";
      const cs = getComputedStyle(cell);
      probe.style.font = cs.font;
      probe.style.fontVariantNumeric = cs.fontVariantNumeric;
      document.body.appendChild(probe);
      const textWidth = probe.getBoundingClientRect().width;
      probe.remove();
      const padLeft = parseFloat(cs.paddingLeft) || 0;
      const padRight = parseFloat(cs.paddingRight) || 0;
      return { textWidth, available: cell.getBoundingClientRect().width - padLeft - padRight };
    });
    if (modifiedCellFit) {
      assert.ok(
        modifiedCellFit.textWidth <= modifiedCellFit.available + 1,
        `${engineName}: timestamp ${modifiedCellFit.textWidth.toFixed(1)}px should fit in ${modifiedCellFit.available.toFixed(1)}px`,
      );
    }

    if (screenshotDir && engineName === "chromium") {
      await page.screenshot({ path: path.join(screenshotDir, "home-columns-default.png") });
    }

    // Reorder to match user screenshot: name | comment | size | modified
    await page.evaluate(() => {
      localStorage.setItem("dbscout.home.columns.v1", JSON.stringify({
        version: 1,
        columns: [
          { key: "name", width: null },
          { key: "comment", width: null },
          { key: "size", width: null },
          { key: "modified", width: null },
        ],
      }));
    });
    await page.reload();
    await page.locator(".wb-dbhome-table-header").waitFor({ state: "visible" });
    await frame();

    const reorderedCommentBefore = await box(header("comment"));
    const reorderedSizeBefore = await box(header("size"));
    assert.ok(
      reorderedCommentBefore.width <= 240,
      `${engineName}: reordered comment column should stay compact, got ${reorderedCommentBefore.width}`,
    );

    if (screenshotDir && engineName === "chromium") {
      await page.screenshot({ path: path.join(screenshotDir, "home-columns-reordered.png") });
    }

    // Drag comment narrower: comment must shrink and size must shift left with it.
    await dragHandle("comment", -60);
    const reorderedCommentAfter = await box(header("comment"));
    const reorderedSizeAfter = await box(header("size"));
    assert.ok(
      Math.abs(reorderedCommentAfter.width - Math.max(80, reorderedCommentBefore.width - 60)) <= 2,
      `${engineName}: comment should shrink smoothly (${reorderedCommentBefore.width} -> ${reorderedCommentAfter.width})`,
    );
    assert.ok(
      reorderedSizeAfter.left < reorderedSizeBefore.left - 40,
      `${engineName}: trailing size column should move left when comment shrinks`,
    );

    // Drag comment all the way to its minimum (80px).
    await dragHandle("comment", -200);
    assert.equal(Math.round((await box(header("comment"))).width), 80, `${engineName}: comment shrinks to 80px min`);

    // Persistence across reload.
    await page.reload();
    await page.locator(".wb-dbhome-table-header").waitFor({ state: "visible" });
    await frame();
    assert.equal(Math.round((await box(header("comment"))).width), 80, `${engineName}: narrowed comment width persists`);

    // Drag name narrower down to 120px: comment must stay 80px, not expand!
    await dragHandle("name", -200);
    assert.equal(Math.round((await box(header("name"))).width), 120, `${engineName}: name shrinks to 120px min`);
    assert.equal(Math.round((await box(header("comment"))).width), 80, `${engineName}: shrinking name does not stretch comment`);

    // Drag size and modified narrower to their compact minimums (72px, 88px).
    await dragHandle("size", -80);
    assert.equal(Math.round((await box(header("size"))).width), 72, `${engineName}: size shrinks to 72px min`);
    await dragHandle("modified", -120);
    assert.equal(Math.round((await box(header("modified"))).width), 88, `${engineName}: modified shrinks to 88px min`);

    if (screenshotDir && engineName === "chromium") {
      await page.screenshot({ path: path.join(screenshotDir, "home-columns-narrowed.png") });
    }

    // Drag comment wider, then double-click handle to reset back to auto width.
    await dragHandle("comment", 260);
    assert.ok(Math.round((await box(header("comment"))).width) >= 330, `${engineName}: comment expands smoothly when dragged right`);
    await doubleClickHandle("comment");
    assert.equal(
      Math.round((await box(header("comment"))).width),
      Math.round(reorderedCommentBefore.width),
      `${engineName}: double-click resets comment to compact automatic width`,
    );

    assert.deepEqual(errors, [], `${engineName}: expected zero page errors`);
    console.log(`PASS ${engineName}: defaults=${JSON.stringify(defaultWidths)}, modifiedFit=${JSON.stringify(modifiedCellFit)}`);
  } finally {
    await browser.close();
  }
}
