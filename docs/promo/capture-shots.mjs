import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Captures the app screenshots the promo video shows, from the browser mock
// (`npm run dev`), in Traditional Chinese and the light theme.
//   DBSCOUT_PROMO_URL=http://127.0.0.1:1431 node docs/promo/capture-shots.mjs
const base = process.env.DBSCOUT_PROMO_URL || "http://127.0.0.1:1431";
const out = fileURLToPath(new URL("./shots/", import.meta.url));
const browser = await chromium.launch({ headless: true });

async function openItem(page) {
  await page.locator('[role="option"]').filter({ hasText: /^item\b/ }).first().dblclick();
  await page.locator('.wb-grid-row td[data-column-index="0"]').first().waitFor();
  await page.waitForTimeout(1200);
}

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(30_000);
  await page.addInitScript(() => {
    localStorage.setItem("dbscout_language", "zh-TW");
    localStorage.setItem("dbscout_theme", "light");
    localStorage.setItem("dbscout_sidebar_collapsed", "0");
  });

  // The item table with a selected cell.
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await openItem(page);
  await page.locator('.wb-grid-row td[data-column-index="1"]').nth(2).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, "grid.png") });

  // Find & replace, filled in.
  await page.keyboard.press("Control+h");
  const inputs = page.locator('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])');
  await inputs.nth(0).fill("药水");
  await inputs.nth(1).fill("仙丹");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, "replace.png") });
  await page.keyboard.press("Escape");

  // The workbench with the connection tree open (background of the glow scene).
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(out, "sidebar.png") });

  // The relation lab's busiest table at depth 2, full screen.
  await page.goto(`${base}/?relationLab=1200`, { waitUntil: "domcontentloaded" });
  await page.locator(".wb-source-connection").filter({ hasText: "Demo GameDB" }).getByText("Demo GameDB").first().click();
  await page.locator(".wb-database-item", { hasText: "relation_lab" }).first().click();
  await page.locator(".wb-table-search input").last().fill("item");
  await page.locator(".wb-search-result").filter({ has: page.locator(".wb-table-name", { hasText: /^item$/ }) }).first().click();
  await page.locator('.wb-grid-row td[data-column-index="0"]').first().waitFor();
  await page.getByRole("tab", { name: /^關聯/ }).click();
  await page.locator(".wb-relation-graph-section .wb-relation-graph-surface").waitFor();
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "全螢幕檢視", exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.locator(".wb-relation-graph-fullscreen .wb-relation-graph-segment button").nth(1).click();
  await page.waitForTimeout(14_000);
  await page.screenshot({ path: join(out, "biggraph.png") });
} finally {
  await browser.close();
}
