// The sidebar must end up showing the database the user switched to, however
// the switch was made (rail tile, tab, sidebar click) and whatever was open
// before. Run against a Vite dev server:
//   DBSCOUT_SIDEBAR_REVEAL_TEST_URL=http://127.0.0.1:1431 node scripts/test-sidebar-database-reveal-browser.mjs
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";

const base = process.env.DBSCOUT_SIDEBAR_REVEAL_TEST_URL || "http://127.0.0.1:1431";
// How long the mock server takes to answer a switch, so the sidebar is asked
// to show the database before, during and after its branches animate.
const latencies = (process.env.DBSCOUT_SIDEBAR_REVEAL_LATENCIES || "0,60,200,400")
  .split(",").map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0);
const browserType = process.env.DBSCOUT_BROWSER_ENGINE === "webkit" ? webkit : chromium;
const browser = await browserType.launch({ headless: true, ...(process.env.DBSCOUT_BROWSER_CHANNEL ? { channel: process.env.DBSCOUT_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => {
  if (error.message === "ResizeObserver loop completed with undelivered notifications.") return;
  errors.push(error.message);
});
page.setDefaultTimeout(20_000);

const PINNED = [
  { connectionId: "demo", database: "bulk_db_055", rail: true },
  { connectionId: "demo", database: "game_db", rail: true },
  { connectionId: "demo-staging", database: "game_db", rail: true },
  { connectionId: "demo-staging", database: "bulk_db_058", rail: true },
  { connectionId: "demo-test", database: "bulk_db_030", rail: true },
];

await page.addInitScript((pinned) => {
  if (sessionStorage.getItem("sidebar-reveal-test-seeded")) return;
  sessionStorage.setItem("sidebar-reveal-test-seeded", "1");
  localStorage.clear();
  localStorage.setItem("dbscout_language", "zh-CN");
  localStorage.setItem("dbscout_sidebar_collapsed", "0");
  localStorage.setItem("dbscout_pinned_databases", JSON.stringify(pinned));
}, PINNED);

const tree = page.locator(".wb-source-tree");

function tile(connectionId, database) {
  return page.locator(`.wb-rail-db-btn[data-wb-rail-sort-id="${connectionId}\\1f ${database}"]`);
}

function connectionNode(label) {
  return page.locator(".wb-connection-node").filter({ hasText: label });
}

function dbRow(name) {
  return page.locator(".wb-database-item").filter({ has: page.getByText(name, { exact: true }) });
}

async function waitForCurrent(label, database) {
  await page.waitForFunction(([connectionLabel, name]) => {
    const node = [...document.querySelectorAll(".wb-source-connection.is-expanded")]
      .find((section) => section.querySelector(".wb-connection-node")?.textContent.includes(connectionLabel));
    const row = node?.querySelector(".wb-database-item.active");
    return row?.querySelector(".wb-tree-label")?.textContent.trim() === name;
  }, [label, database]);
}

async function settle() {
  await page.waitForFunction(() => !document.querySelector(".wb-branch-enter-active, .wb-branch-leave-active"));
  await page.waitForTimeout(450);
}

// Where the current database row sits inside the tree's visible area.
async function currentRowPlacement() {
  return page.evaluate(() => {
    const container = document.querySelector(".wb-source-tree");
    const row = container?.querySelector(".wb-source-connection.is-expanded .wb-database-item.active");
    if (!container || !row) return { found: false };
    const box = container.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return {
      found: true,
      name: row.querySelector(".wb-tree-label")?.textContent.trim(),
      above: Math.round(box.top - rect.top),
      below: Math.round(rect.bottom - box.bottom),
      scrollTop: Math.round(container.scrollTop),
    };
  });
}

async function expectCurrentVisible(label, database, scenario) {
  await waitForCurrent(label, database);
  await settle();
  const placement = await currentRowPlacement();
  assert.equal(placement.found, true, `${scenario}: current database row is rendered`);
  assert.equal(placement.name, database, `${scenario}: current database`);
  assert.ok(
    placement.above <= 0 && placement.below <= 0,
    `${scenario}: ${database} must be inside the visible list, got ${JSON.stringify(placement)}`,
  );
}

async function scrollTree(top) {
  await tree.evaluate((node, value) => { node.scrollTop = value; }, top);
  await page.waitForTimeout(60);
}

const failures = [];
let latency = 0;
async function scenario(name, run) {
  const title = `[${latency}ms] ${name}`;
  try {
    await run();
    console.log(`ok   ${title}`);
  } catch (error) {
    failures.push(title);
    console.log(`FAIL ${title}\n     ${String(error?.message || error).split("\n")[0]}`);
  }
}

async function runScenarios() {
  await page.goto(`${base}?mockDatabases=60`, { waitUntil: "domcontentloaded" });
  await page.locator(".wb-tab[data-kind='home']").first().waitFor();
  await tile("demo", "bulk_db_055").waitFor();
  await page.evaluate((value) => { globalThis.__DBSCOUT_MOCK_SOURCE_LATENCY_MS__ = value; }, latency);

  await scenario("rail tile: a database far down the same server", async () => {
    await tile("demo", "bulk_db_055").click();
    await expectCurrentVisible("Demo GameDB", "bulk_db_055", "same server");
  });

  await scenario("rail tile: first database of a server below a long open list", async () => {
    await tile("demo-staging", "game_db").click();
    await expectCurrentVisible("Staging Server", "game_db", "server below");
  });

  await scenario("rail tile: a database far down a server above", async () => {
    await tile("demo", "bulk_db_055").click();
    await expectCurrentVisible("Demo GameDB", "bulk_db_055", "server above");
  });

  await scenario("rail tile: far down one server to far down another", async () => {
    await tile("demo-staging", "bulk_db_058").click();
    await expectCurrentVisible("Staging Server", "bulk_db_058", "far to far");
    await tile("demo-test", "bulk_db_030").click();
    await expectCurrentVisible("Test Server", "bulk_db_030", "far to middle");
    await tile("demo", "game_db").click();
    await expectCurrentVisible("Demo GameDB", "game_db", "back to the top");
  });

  await scenario("rail tile: quick switches end on the last database", async () => {
    await tile("demo-staging", "bulk_db_058").click();
    await tile("demo", "bulk_db_055").click();
    await tile("demo-test", "bulk_db_030").click();
    await expectCurrentVisible("Test Server", "bulk_db_030", "quick switches");
  });

  await scenario("tab switch across servers", async () => {
    await tile("demo", "bulk_db_055").click();
    await expectCurrentVisible("Demo GameDB", "bulk_db_055", "open first home");
    await dbRow("bulk_db_055").first().click();
    await page.locator(".wb-table-branch .wb-table-item").first().click();
    await page.locator(".wb-tab[data-kind='data']").first().waitFor();
    await tile("demo-staging", "game_db").click();
    await expectCurrentVisible("Staging Server", "game_db", "second server");
    await page.locator(".wb-tab[data-kind='data']").first().click();
    await expectCurrentVisible("Demo GameDB", "bulk_db_055", "tab switch back");
  });

  await scenario("sidebar click below an opened table list", async () => {
    await tile("demo", "game_db").click();
    await expectCurrentVisible("Demo GameDB", "game_db", "top database");
    await dbRow("game_db").first().click();
    await page.locator(".wb-table-branch").first().waitFor();
    await settle();
    await tile("demo", "bulk_db_055").click();
    await expectCurrentVisible("Demo GameDB", "bulk_db_055", "after an opened table list");
  });

  await scenario("user scrolling right after a switch is left alone", async () => {
    await tile("demo", "game_db").click();
    await expectCurrentVisible("Demo GameDB", "game_db", "top database");
    await scrollTree(900);
    const before = (await currentRowPlacement()).scrollTop;
    assert.ok(before > 300, "the list scrolled away from the current database");
    await page.waitForTimeout(500);
    assert.equal((await currentRowPlacement()).scrollTop, before, "the list stays where the user left it");
  });

  await scenario("switching while the sidebar is hidden shows the database once it opens", async () => {
    await tile("demo", "game_db").click();
    await expectCurrentVisible("Demo GameDB", "game_db", "top database");
    await page.locator(".wb-titlebar-sidebar .wb-topbar-collapse-btn").click();
    await page.waitForFunction(() => document.querySelector(".wb-sidebar")?.classList.contains("is-collapsed"));
    await tile("demo-staging", "bulk_db_058").click();
    await page.waitForTimeout(700);
    await page.locator(".wb-titlebar-sidebar .wb-topbar-collapse-btn").click();
    await page.waitForFunction(() => !document.querySelector(".wb-sidebar")?.classList.contains("is-collapsed"));
    await expectCurrentVisible("Staging Server", "bulk_db_058", "after reopening");
  });
}

try {
  for (latency of latencies) await runScenarios();

  assert.deepEqual(errors, [], "no page errors");
  assert.deepEqual(failures, [], "every scenario keeps the current database visible");
  console.log("sidebar database reveal: all scenarios passed");
} finally {
  await browser.close();
}
