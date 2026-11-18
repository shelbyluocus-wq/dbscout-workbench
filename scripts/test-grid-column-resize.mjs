import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";

const base = process.env.DBSCOUT_GRID_TEST_URL || "http://127.0.0.1:8099";

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 780 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(() => localStorage.setItem("dbscout_language", "zh-CN"));
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/?perfProfile=deterministic-v1&scenario=schema-800x60`);
    await page.locator('[role="option"]').first().dblclick();

    const wrap = page.locator(".wb-grid-wrap");
    const header = page.locator('th[data-column-index="0"]');
    const neighbor = page.locator('th[data-column-index="1"]');
    const grip = header.locator(".wb-col-resize");
    const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const width = (element) => element.evaluate((el) => el.getBoundingClientRect().width);
    const scroll = async (left) => {
      await wrap.evaluate((el, value) => { el.scrollLeft = value; }, left);
      await frame();
    };
    async function gripPoint(handle = grip) {
      const point = await handle.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        return { x, y, reachable: document.elementFromPoint(x, y) === el };
      });
      assert.ok(point.reachable, `resize handle should be reachable at ${point.x}, ${point.y}`);
      return point;
    }
    async function startDrag(handle = grip) {
      await handle.hover();
      const { x, y } = await gripPoint(handle);
      await page.mouse.move(x, y);
      await page.mouse.down();
      return { x, y };
    }
    async function dragBy(delta, handle = grip) {
      const { x, y } = await startDrag(handle);
      await page.mouse.move(x + delta, y, { steps: 8 });
      await page.mouse.up();
      await frame();
    }
    async function resetWidth(handle = grip) {
      await handle.hover();
      const { x, y } = await gripPoint(handle);
      await page.mouse.dblclick(x, y);
      await frame();
    }

    await page.waitForFunction(() => document.querySelector('th[data-column-index="0"]')?.style.width);
    const original = await width(header);
    const neighborWidth = await width(neighbor);
    await dragBy(240);
    assert.equal(await width(header), original + 240);
    await dragBy(-240);
    assert.equal(await width(header), original);
    await dragBy(-100);
    assert.equal(await width(header), 40);
    await resetWidth();
    assert.equal(await width(header), original);

    // The drag's target can leave the rendered column window while held.
    const { x, y } = await startDrag();
    await page.mouse.move(x + 120, y);
    await frame();
    assert.equal(await width(header), original + 120, "the width should update before mouseup");
    await scroll(3000);
    await header.waitFor({ state: "detached" });
    const visibleHeaders = () => wrap.locator("thead tr:first-child th[data-column-index]").evaluateAll(
      (elements) => elements.map((el) => [el.dataset.columnIndex, el.getBoundingClientRect().width]),
    );
    const distantWidths = new Map(await visibleHeaders());
    await page.mouse.move(x + 240, y);
    await page.mouse.up();
    await frame();
    for (const [index, currentWidth] of await visibleHeaders()) {
      if (distantWidths.has(index)) assert.equal(currentWidth, distantWidths.get(index), `column ${index} must keep its width`);
    }
    await scroll(0);
    assert.equal(await width(header), original + 240);
    assert.equal(await width(neighbor), neighborWidth);
    await resetWidth();

    // Ordinary and frozen headers both keep a reachable handle when their
    // column extends beyond a narrow pane, even after horizontal scrolling.
    for (const frozen of [false, true]) {
      await page.setViewportSize({ width: 1200, height: 780 });
      await scroll(0);
      if (frozen) {
        await page.locator('.wb-grid-row td[data-column-index="0"]').first().click();
        await page.getByRole("button", { name: "冻结选项", exact: true }).click();
        await page.getByRole("menuitem", { name: "冻结到当前列", exact: true }).click();
        await page.locator('th[data-column-index="0"].frozen-col').waitFor();
      }
      const largeDelta = 1000 - (await gripPoint()).x;
      await dragBy(largeDelta);
      await page.setViewportSize({ width: 780, height: 780 });
      await page.waitForFunction(() => {
        const header = document.querySelector('th[data-column-index="0"]');
        return header?.getBoundingClientRect().right > header?.closest(".wb-grid-wrap").getBoundingClientRect().right + 50;
      });
      const wideWidth = await width(header);
      await dragBy(-150);
      assert.equal(await width(header), wideWidth - 150, `oversized ${frozen ? "frozen" : "ordinary"} column should shrink`);
      await scroll(400);
      await resetWidth();
      assert.equal(await width(header), original);
      await gripPoint();
      await scroll(0);
      await grip.focus();
      await page.keyboard.press("Shift+ArrowRight");
      await frame();
      assert.equal(await width(header), original + 32);
      await resetWidth();
    }

    // Exercise both sides of the frozen boundary after a real horizontal wheel.
    await page.setViewportSize({ width: 1200, height: 780 });
    await page.locator('.wb-grid-row td[data-column-index="1"]').first().click();
    await page.getByRole("button", { name: "冻结选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "冻结到当前列", exact: true }).click();
    await page.locator('th[data-column-index="1"].frozen-col').waitFor();
    const neighborGrip = neighbor.locator(".wb-col-resize");
    const left = (element) => element.evaluate((el) => el.getBoundingClientRect().left);
    const frozenLeft = await left(header);
    await wrap.hover();
    await page.mouse.wheel(600, 0);
    await page.waitForFunction(() => document.querySelector(".wb-grid-wrap").scrollLeft >= 500);
    await frame();
    assert.equal(await left(header), frozenLeft);
    const ordinaryIndex = await wrap.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const frozenRight = el.querySelector('th[data-column-index="1"]').getBoundingClientRect().right;
      return [...el.querySelectorAll("thead tr:first-child th[data-column-index]:not(.frozen-col)")]
        .find((th) => {
          const rect = th.getBoundingClientRect();
          return rect.right > frozenRight + 85 && rect.right < box.right - 70;
        })?.dataset.columnIndex;
    });
    assert.ok(ordinaryIndex, "an ordinary resize handle is visible after scrolling");
    const ordinary = page.locator(`th[data-column-index="${ordinaryIndex}"]`);
    const ordinaryGrip = ordinary.locator(".wb-col-resize");
    const ordinaryWidth = await width(ordinary);
    await dragBy(48);
    assert.equal(await width(header), original + 48);
    assert.equal(await left(neighbor), frozenLeft + original + 48);
    assert.equal(await width(ordinary), ordinaryWidth);
    assert.equal(await width(neighbor), neighborWidth);
    await dragBy(-24, neighborGrip);
    assert.equal(await width(neighbor), neighborWidth - 24);
    await dragBy(64, ordinaryGrip);
    assert.equal(await width(ordinary), ordinaryWidth + 64);
    assert.equal(await width(header), original + 48);
    assert.equal(await width(neighbor), neighborWidth - 24);
    assert.equal(await width(page.locator(`.wb-grid-row td[data-column-index="${ordinaryIndex}"]`).first()), ordinaryWidth + 64);
    await resetWidth(grip);
    await resetWidth(neighborGrip);

    // Leave just the right edge of the ordinary column in view, then shrink
    // it across the frozen boundary. The same handle must stay reachable.
    const edgeGap = await ordinary.evaluate((el) => {
      const frozen = el.closest("table").querySelector('th[data-column-index="1"]');
      return el.getBoundingClientRect().right - frozen.getBoundingClientRect().right;
    });
    const scrollLeft = await wrap.evaluate((el) => el.scrollLeft);
    await scroll(scrollLeft + edgeGap - 20);
    await gripPoint(ordinaryGrip);
    await dragBy(-48, ordinaryGrip);
    assert.equal(await width(ordinary), ordinaryWidth + 16);
    await gripPoint(ordinaryGrip);
    await dragBy(-8, ordinaryGrip);
    assert.equal(await width(ordinary), ordinaryWidth + 8);
    await resetWidth(ordinaryGrip);
    assert.equal(await width(ordinary), ordinaryWidth);
    assert.equal(await width(header), original);
    assert.equal(await width(neighbor), neighborWidth);

    // At the far right, shrinking the last column also clamps scrollLeft.
    await scroll(await wrap.evaluate((el) => el.scrollWidth));
    const last = page.locator('th[data-column-index="59"]');
    const lastGrip = last.locator(".wb-col-resize");
    const lastWidth = await width(last);
    await dragBy(-16, lastGrip);
    assert.equal(await width(last), lastWidth - 16);
    await resetWidth(lastGrip);
    assert.equal(await width(last), lastWidth);
    assert.equal(await left(header), frozenLeft);
    await scroll(0);

    // Resize the window in both directions while a frozen column is held.
    const resizing = await startDrag();
    await page.mouse.move(resizing.x + 48, resizing.y);
    await page.setViewportSize({ width: 810, height: 640 });
    await frame();
    assert.equal(await width(header), original + 48);
    await page.mouse.move(resizing.x + 24, resizing.y);
    await page.setViewportSize({ width: 1200, height: 780 });
    await page.mouse.up();
    await frame();
    assert.equal(await width(header), original + 24);
    assert.equal(await width(neighbor), neighborWidth);

    // Toggle real browser fullscreen while an ordinary column is held.
    const fullscreenColumn = page.locator('th[data-column-index="2"]');
    const fullscreenGrip = fullscreenColumn.locator(".wb-col-resize");
    const fullscreenWidth = await width(fullscreenColumn);
    const fullscreenDrag = await startDrag(fullscreenGrip);
    await page.mouse.move(fullscreenDrag.x + 40, fullscreenDrag.y);
    await page.evaluate(() => document.documentElement.requestFullscreen());
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    assert.equal(await width(fullscreenColumn), fullscreenWidth + 40);
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.mouse.move(fullscreenDrag.x + 24, fullscreenDrag.y);
    await page.mouse.up();
    await frame();
    assert.equal(await width(fullscreenColumn), fullscreenWidth + 24);
    assert.equal(await width(header), original + 24);
    assert.equal(await width(neighbor), neighborWidth);

    // A keyboard tab switch can occur with the pointer still held. The
    // original tab keeps its last drag width and releases the cursor.
    const dataTab = page.locator('.wb-tab[data-kind="data"]').first();
    const homeTab = page.locator('.wb-tab[data-kind="home"]').first();
    const held = await startDrag(grip);
    await page.mouse.move(held.x + 32, held.y);
    await homeTab.press("Enter");
    await page.waitForFunction(() => document.querySelector(".wb-tab.active")?.dataset.kind === "home");
    await page.mouse.move(held.x + 95, held.y);
    await page.mouse.up();
    assert.notEqual(await page.evaluate(() => document.body.style.cursor), "col-resize");
    await homeTab.waitFor();
    await dataTab.click();
    await header.waitFor();
    assert.equal(await width(header), original + 56);
    assert.equal(await width(neighbor), neighborWidth);
    assert.equal(await width(fullscreenColumn), fullscreenWidth + 24);
    await resetWidth(fullscreenGrip);
    await resetWidth();

    await homeTab.click();
    await page.locator('[role="option"]').nth(1).dblclick();
    const otherDataTab = page.locator('.wb-tab[data-kind="data"]').nth(1);
    await otherDataTab.waitFor();
    const otherWidth = await width(header);
    await dataTab.click();
    await frame();
    const switching = await startDrag();
    await page.mouse.move(switching.x + 28, switching.y);
    await otherDataTab.press("Enter");
    await frame();
    await page.mouse.move(switching.x + 100, switching.y);
    await page.mouse.up();
    await frame();
    assert.equal(await width(header), otherWidth);
    assert.notEqual(await page.evaluate(() => document.body.style.cursor), "col-resize");
    await dataTab.click();
    await frame();
    assert.equal(await width(header), original + 28);
    assert.equal(await width(neighbor), neighborWidth);
    await resetWidth();

    // Give the same field three different manual widths in three open tables.
    await homeTab.click();
    await page.locator('[role="option"]').nth(2).dblclick();
    const thirdDataTab = page.locator('.wb-tab[data-kind="data"]').nth(2);
    await thirdDataTab.waitFor();
    const openTables = [dataTab, otherDataTab, thirdDataTab];
    const fieldName = await header.getAttribute("data-column-name");
    const manualWidths = [];
    for (const [index, table] of openTables.entries()) {
      await table.click();
      await frame();
      assert.equal(await header.getAttribute("data-column-name"), fieldName);
      const manualWidth = 160 + index * 80;
      await dragBy(manualWidth - await width(header));
      assert.equal(await width(header), manualWidth);
      manualWidths.push(manualWidth);
    }
    for (const index of [0, 2, 1, 0, 1, 2]) {
      await openTables[index].click();
      await frame();
      assert.equal(await width(header), manualWidths[index], `table ${index + 1} must keep its own width`);
      assert.equal(await width(page.locator('.wb-grid-row td[data-column-index="0"]').first()), manualWidths[index]);
    }
    await resetWidth();
    await otherDataTab.click();
    await frame();
    assert.equal(await width(header), manualWidths[1], "resetting the third table must leave the second table's width intact");
    await dataTab.click();
    await frame();
    assert.equal(await width(header), manualWidths[0], "resetting the third table must leave the first table's width intact");
    await resetWidth();

    // Keep a frozen column at the minimum and an ordinary column wider than
    // the viewport, then refresh each table through the app's F5 shortcut.
    await otherDataTab.click();
    await frame();
    await resetWidth();
    const ordinaryAutoWidth = await width(header);
    const wideDelta = 1100 - Math.ceil((await gripPoint()).x);
    await dragBy(wideDelta);
    const extremeWidth = ordinaryAutoWidth + wideDelta;
    assert.equal(await width(header), extremeWidth);
    await dataTab.click();
    await frame();
    await dragBy(-100);
    assert.equal(await width(header), 40);
    await page.setViewportSize({ width: 800, height: 680 });
    await wrap.hover();
    await page.evaluate(() => { window.__DBSCOUT_MOCK_PAGE_LATENCY_MS__ = 220; });
    async function refreshAndCheck(expectedWidth) {
      await page.keyboard.press("F5");
      await wrap.locator(".wb-grid-loading").waitFor();
      await wrap.locator(".wb-grid-loading").waitFor({ state: "hidden" });
      await frame();
      assert.equal(await width(header), expectedWidth);
      assert.equal(await width(page.locator('.wb-grid-row td[data-column-index="0"]').first()), expectedWidth);
    }
    await refreshAndCheck(40);
    await otherDataTab.click();
    await frame();
    assert.equal(await width(header), extremeWidth);
    await refreshAndCheck(extremeWidth);
    await dragBy(-96);
    assert.equal(await width(header), extremeWidth - 96);
    await resetWidth();
    assert.equal(await width(header), ordinaryAutoWidth);
    await dataTab.click();
    await frame();
    assert.equal(await width(header), 40);
    await dragBy(32);
    assert.equal(await width(header), 72);
    await resetWidth();
    assert.equal(await width(header), original);
    await page.evaluate(() => { delete window.__DBSCOUT_MOCK_PAGE_LATENCY_MS__; });

    // Losing focus ends the drag and restores the normal cursor.
    const active = await startDrag();
    await page.mouse.move(active.x + 90, active.y);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.mouse.move(active.x + 180, active.y);
    await page.mouse.up();
    await frame();
    assert.equal(await width(header), original + 90);
    assert.notEqual(await page.evaluate(() => document.body.style.cursor), "col-resize");

    // Reload immediately after changing a width, before the coalesced save.
    await dragBy(-200);
    assert.equal(await width(header), 40);
    await otherDataTab.click();
    await frame();
    const reloadDelta = 760 - Math.ceil((await gripPoint()).x);
    await dragBy(reloadDelta);
    const reloadedWideWidth = ordinaryAutoWidth + reloadDelta;
    assert.equal(await width(header), reloadedWideWidth);
    await page.reload();
    await otherDataTab.waitFor();
    await header.waitFor();
    assert.equal(await width(header), reloadedWideWidth);
    await dataTab.click();
    await header.waitFor();
    assert.equal(await width(header), 40);
    await resetWidth();
    await page.reload();
    await header.waitFor();
    assert.equal(await width(header), original);
    await otherDataTab.click();
    await header.waitFor();
    assert.equal(await width(header), reloadedWideWidth);
    await resetWidth();
    assert.equal(await width(header), ordinaryAutoWidth);
    assert.deepEqual(errors, []);
    console.log(`${engine.name()} column resizing passed.`);
  } finally {
    await browser.close();
  }
}
