import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.DBSCOUT_SMOKE_URL ?? "http://127.0.0.1:1431/";
const url = new URL(baseUrl);
url.searchParams.set("mockTables", "940");

function assertStable(label, before, after, tolerance = 1) {
  assert.ok(
    Math.abs(after - before) <= tolerance,
    `${label} should stay within ${tolerance}px (before=${before}, after=${after})`,
  );
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function waitForSidebarTransitions(page) {
  await page.waitForFunction(
    () => !document.querySelector(".wb-branch-enter-active, .wb-branch-leave-active"),
    undefined,
    { timeout: 2_000 },
  );
  await settle(page);
}

async function boot(page, databaseOrder) {
  const bootUrl = new URL(url);
  bootUrl.searchParams.set("smokeDatabaseOrder", databaseOrder.join(","));
  await page.goto(bootUrl.href, { waitUntil: "networkidle" });
  await page.locator(".mysql-workbench").waitFor({ state: "visible" });
  const gameDatabase = page.locator(".wb-database-item", { hasText: "game_db" }).first();
  await gameDatabase.waitFor({ state: "visible" });
  assert.equal(await gameDatabase.getAttribute("aria-expanded"), "true");
  await page.locator(".wb-table-scroll").waitFor({ state: "visible" });
  await page.locator(".wb-table-item[data-table-name]").first().waitFor({ state: "visible" });
  await waitForSidebarTransitions(page);
}

async function geometry(page) {
  return page.evaluate(() => {
    const rectTop = (selector, text = "") => {
      const elements = [...document.querySelectorAll(selector)];
      const element = text ? elements.find((item) => item.textContent?.includes(text)) : elements[0];
      return element?.getBoundingClientRect().top ?? null;
    };
    const nav = document.querySelector(".wb-source-tree");
    const tableScroll = document.querySelector(".wb-table-scroll");
    const connectionList = document.querySelector(".wb-source-connection-list");
    const expandedConnection = document.querySelector(".wb-source-connection.is-expanded");
    const databaseList = document.querySelector(".wb-source-database-list");
    return {
      gameDatabaseTop: rectTop(".wb-database-item", "game_db"),
      gameConfigTop: rectTop(".wb-database-item", "game_config"),
      navScrollTop: nav?.scrollTop ?? null,
      navClientHeight: nav?.clientHeight ?? null,
      navScrollHeight: nav?.scrollHeight ?? null,
      connectionListHeight: connectionList?.getBoundingClientRect().height ?? null,
      connectionListScrollHeight: connectionList?.scrollHeight ?? null,
      expandedConnectionHeight: expandedConnection?.getBoundingClientRect().height ?? null,
      databaseListHeight: databaseList?.getBoundingClientRect().height ?? null,
      databaseRowsHeight: [...document.querySelectorAll(".wb-source-database")]
        .reduce((sum, item) => sum + item.getBoundingClientRect().height, 0),
      tableScrollTop: tableScroll?.scrollTop ?? null,
      tableClientHeight: tableScroll?.clientHeight ?? null,
      tableScrollHeight: tableScroll?.scrollHeight ?? null,
      tableOverscroll: tableScroll ? getComputedStyle(tableScroll).overscrollBehavior : "",
      mountedRows: document.querySelectorAll(".wb-table-item[data-table-name]").length,
    };
  });
}

async function scrollTablesToBottom(page) {
  await page.locator(".wb-table-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await settle(page);
}

async function scrollTablesToMiddle(page) {
  await page.locator(".wb-table-scroll").evaluate((element) => {
    element.scrollTop = Math.max(0, (element.scrollHeight - element.clientHeight) / 2);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await settle(page);
}

async function tableCoverage(page) {
  return page.evaluate(() => {
    const viewport = document.querySelector(".wb-table-scroll")?.getBoundingClientRect();
    const search = document.querySelector(".wb-table-search-wrap")?.getBoundingClientRect();
    const rows = [...document.querySelectorAll(".wb-table-item[data-table-name]")]
      .map((row) => row.getBoundingClientRect())
      .filter((rect) => rect.bottom > (search?.bottom ?? viewport?.top ?? 0) && rect.top < (viewport?.bottom ?? 0))
      .sort((left, right) => left.top - right.top);
    return {
      visibleRows: rows.length,
      topGap: rows.length ? Math.max(0, rows[0].top - (search?.bottom ?? viewport?.top ?? 0)) : Number.POSITIVE_INFINITY,
      bottomGap: rows.length ? Math.max(0, (viewport?.bottom ?? 0) - rows.at(-1).bottom) : Number.POSITIVE_INFINITY,
      largestRowGap: rows.slice(1).reduce(
        (largest, row, index) => Math.max(largest, row.top - rows[index].bottom),
        0,
      ),
    };
  });
}

function assertTableCoverage(label, coverage) {
  assert.ok(coverage.visibleRows >= 2, `${label} should render visible table rows (${JSON.stringify(coverage)})`);
  assert.ok(coverage.topGap <= 28, `${label} should not leave a blank gap below search (${JSON.stringify(coverage)})`);
  assert.ok(coverage.bottomGap <= 28, `${label} should fill the table viewport (${JSON.stringify(coverage)})`);
  assert.ok(coverage.largestRowGap <= 1, `${label} should keep rows contiguous (${JSON.stringify(coverage)})`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
await page.addInitScript(() => {
  const order = new URLSearchParams(location.search).get("smokeDatabaseOrder")?.split(",").filter(Boolean);
  if (!order?.length) return;
  localStorage.clear();
  localStorage.setItem("dbscout_sidebar_collapsed", "0");
  localStorage.setItem("dbscout_database_order", JSON.stringify({ demo: order }));
});

try {
  // 当前库在第一项：后续数据库名应固定在表区下方。
  await boot(page, ["game_db", "game_config"]);
  assertTableCoverage("top", await tableCoverage(page));
  await scrollTablesToMiddle(page);
  assertTableCoverage("middle", await tableCoverage(page));
  const firstBefore = await geometry(page);
  await scrollTablesToBottom(page);
  assertTableCoverage("bottom", await tableCoverage(page));
  const firstAfter = await geometry(page);

  assert.ok(firstAfter.tableScrollTop > 0, "940-table viewport should have an independent scroll range");
  assert.equal(firstAfter.navScrollTop, firstBefore.navScrollTop, "table scrolling must not move database navigation");
  assertStable("selected database", firstBefore.gameDatabaseTop, firstAfter.gameDatabaseTop);
  assertStable("following database", firstBefore.gameConfigTop, firstAfter.gameConfigTop);
  assert.equal(firstAfter.tableOverscroll, "contain");
  assert.ok(firstAfter.mountedRows < 120, `virtual table rows should stay bounded, got ${firstAfter.mountedRows}`);

  const firstGameDatabase = page.locator(".wb-database-item", { hasText: "game_db" }).first();
  await firstGameDatabase.click();
  await page.locator(".wb-table-scroll").waitFor({ state: "detached" });
  await firstGameDatabase.click();
  await page.locator(".wb-table-scroll").waitFor({ state: "visible" });
  await page.locator(".wb-table-item[data-table-name]").first().waitFor({ state: "visible" });
  await waitForSidebarTransitions(page);
  assertTableCoverage("reopened top", await tableCoverage(page));
  await scrollTablesToMiddle(page);
  assertTableCoverage("reopened middle", await tableCoverage(page));

  const navBeforeSearch = (await geometry(page)).navScrollTop;
  const searchInput = page.locator(".wb-table-search input");
  await searchInput.fill("stress_table_799");
  const firstResult = page.locator(".wb-search-result").first();
  await firstResult.waitFor({ state: "visible" });
  await settle(page);
  const searchProbe = await page.evaluate(() => {
    const nav = document.querySelector(".wb-source-tree");
    const viewport = document.querySelector(".wb-table-scroll")?.getBoundingClientRect();
    const search = document.querySelector(".wb-table-search-wrap")?.getBoundingClientRect();
    const result = document.querySelector(".wb-search-result")?.getBoundingClientRect();
    return {
      navScrollTop: nav?.scrollTop ?? null,
      viewportBottom: viewport?.bottom ?? null,
      searchBottom: search?.bottom ?? null,
      resultTop: result?.top ?? null,
      resultBottom: result?.bottom ?? null,
    };
  });
  assert.equal(searchProbe.navScrollTop, navBeforeSearch, "search reveal must stay inside the table viewport");
  assert.ok(searchProbe.resultTop >= searchProbe.searchBottom, "search result should appear below the sticky search field");
  assert.ok(searchProbe.resultBottom <= searchProbe.viewportBottom, "search result should be visible inside the table viewport");

  // 当前库在第二项：滚动和收起都不得改变它原本的纵向位置。
  await boot(page, ["game_config", "game_db"]);
  const secondBefore = await geometry(page);
  await scrollTablesToBottom(page);
  const secondAfterScroll = await geometry(page);
  assertStable("second-position database", secondBefore.gameDatabaseTop, secondAfterScroll.gameDatabaseTop);
  assert.equal(secondAfterScroll.navScrollTop, secondBefore.navScrollTop);

  const gameDatabase = page.locator(".wb-database-item", { hasText: "game_db" }).first();
  await gameDatabase.click();
  await page.locator(".wb-table-scroll").waitFor({ state: "detached" });
  await settle(page);
  const secondAfterCollapse = await geometry(page);
  assertStable("collapsed second-position database", secondBefore.gameDatabaseTop, secondAfterCollapse.gameDatabaseTop);
  assert.equal(secondAfterCollapse.navScrollTop, secondBefore.navScrollTop);

  // 极矮窗口下导航区可独立溢出；表区到边界后不把滚动传给导航区。
  await page.setViewportSize({ width: 1280, height: 300 });
  await boot(page, ["game_db", "game_config"]);
  // The desktop shell intentionally has a 720px minimum height. Override only that shell guard
  // here so this regression can exercise the navigation overflow fallback in a constrained pane.
  await page.addStyleTag({
    content: ".mysql-workbench { height: 300px !important; min-height: 0 !important; }",
  });
  await settle(page);
  const overflowProbe = await geometry(page);
  assert.ok(
    overflowProbe.navScrollHeight > overflowProbe.navClientHeight,
    `database navigation should expose its own overflow fallback in a short viewport ` +
      `(scrollHeight=${overflowProbe.navScrollHeight}, clientHeight=${overflowProbe.navClientHeight}, ` +
      `connectionList=${overflowProbe.connectionListHeight}/${overflowProbe.connectionListScrollHeight}, ` +
      `expandedConnection=${overflowProbe.expandedConnectionHeight}, databases=${overflowProbe.databaseListHeight}/` +
      `${overflowProbe.databaseRowsHeight})`,
  );
  await page.locator(".wb-source-tree").evaluate((element) => {
    element.scrollTop = Math.min(24, element.scrollHeight - element.clientHeight);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await scrollTablesToBottom(page);
  const navBeforeWheel = (await geometry(page)).navScrollTop;
  await page.locator(".wb-table-scroll").hover();
  await page.mouse.wheel(0, 1200);
  await settle(page);
  const navAfterWheel = (await geometry(page)).navScrollTop;
  assert.equal(navAfterWheel, navBeforeWheel, "table overscroll must not chain into database navigation");
} finally {
  await browser.close();
}

console.log("PASS: sidebar database rows stay fixed while the dedicated virtual table viewport scrolls.");
