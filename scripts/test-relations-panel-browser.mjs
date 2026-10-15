import assert from "node:assert/strict";
import { chromium } from "playwright";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The inspector relation page against the browser mock: the count on the
// relation switch, the selected row's identity, evidence on demand, opening
// every referencing row as one tab, following a reference to its row, and
// remembered section state.
const base = process.env.DBSCOUT_RELATIONS_TEST_URL || "http://127.0.0.1:1431";
const shots = process.env.DBSCOUT_RELATIONS_SCREENSHOTS || tmpdir();
const channel = process.env.DBSCOUT_PLAYWRIGHT_CHANNEL || undefined;
const browser = await chromium.launch({ headless: true, channel });
const errors = [];

async function openTable(page, name) {
  const home = page.locator(".wb-tab").filter({ hasText: /^首页/ }).first();
  if (await home.count()) await home.click();
  const row = page.locator('[role="option"]').filter({ hasText: new RegExp(`^${name}\\b`) });
  await row.first().waitFor();
  await row.first().dblclick();
  await page.locator('.wb-grid-row td[data-column-index="0"]').first().waitFor();
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("dbscout_language", "zh-CN");
    if (!sessionStorage.getItem("relations-panel-test")) {
      sessionStorage.setItem("relations-panel-test", "1");
      localStorage.removeItem("dbscout_relation_graph_options");
      localStorage.removeItem("dbscout_relation_panel_sections");
    }
  });
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await openTable(page, "item");

  // The relation switch counts the table's relations and flags the one to review.
  const relationTab = page.getByRole("tab", { name: /^关联/ });
  const badge = relationTab.locator(".wb-inspector-view-count");
  await badge.waitFor();
  assert.equal((await badge.textContent()).trim(), "5");
  // The conflict appears once the client code has been read.
  await page.waitForFunction(() => document.querySelector(".wb-inspector-view-count")?.classList.contains("needs-review"));
  await relationTab.click();

  const panel = page.locator(".wb-relations-panel");
  await page.waitForFunction(() => !document.querySelector(".wb-relations-panel")?.textContent.includes("正在分析客户端代码"));
  await panel.getByText("在表格中选中一行", { exact: false }).waitFor();

  // Selecting a row names it by key and label in the section header.
  await page.locator('.wb-grid-row td[data-column-index="1"]').first().click();
  const identity = panel.locator(".wb-relations-row-identity");
  await page.waitForFunction(() => document.querySelector(".wb-relations-row-identity")?.textContent.includes("id=1"));
  assert.match(await identity.textContent(), /^id=1 · \S+/);
  const dropTable = panel.locator(".wb-incoming-relation").filter({ hasText: "drop_table.item_id" });
  await page.waitForFunction(() => [...document.querySelectorAll(".wb-incoming-relation")]
    .some((element) => element.textContent.includes("drop_table.item_id") && /\d+ 行/.test(element.textContent)));
  const referencing = Number((await dropTable.locator(".wb-incoming-count").textContent()).match(/\d+/)[0]);
  assert.ok(referencing > 1, `${referencing} drops reference the item`);

  // Columns that do not reference the row wait behind one quiet toggle.
  const quiet = panel.locator(".wb-relations-quiet-toggle").filter({ hasText: "没有引用本行" });
  await quiet.waitFor();
  assert.equal(await panel.locator(".wb-relations-quiet-list").count(), 0);
  await quiet.click();
  assert.ok(await panel.locator(".wb-relations-quiet-list li").count() > 0);

  // Evidence opens on demand with the comment and the code location.
  const card = panel.locator(".wb-relation-card").filter({ hasText: "drop_table.item_id" });
  assert.equal(await card.locator(".wb-relation-card-details").count(), 0);
  await card.locator(".wb-relation-card-row").click();
  const details = card.locator(".wb-relation-card-details");
  await details.waitFor();
  assert.match(await details.textContent(), /注释/);
  assert.match(await details.textContent(), /DropPreview\.ts:\d+/);
  assert.equal(await card.locator(".wb-relation-card-disclosure").getAttribute("aria-expanded"), "true");
  // Hovering a table name reveals its comment in a card; leaving lets it go.
  const shop = panel.locator(".wb-relation-card .wb-table-mention").filter({ hasText: /^shop$/ }).first();
  await shop.hover();
  const tip = page.locator(".wb-table-tip.is-placed");
  await tip.waitFor();
  assert.match(await tip.textContent(), /shop\s*商店配置表/);
  assert.equal(await shop.getAttribute("aria-describedby"), await tip.getAttribute("id"));
  await page.mouse.move(4, 4);
  await page.waitForFunction(() => !document.querySelector(".wb-table-tip"));
  await page.locator(".wb-inspector").screenshot({ path: join(shots, "blackcat-relations-panel.png") });

  // Every referencing drop opens as one filtered tab that lands on its first row.
  await dropTable.locator(".wb-incoming-open").click();
  await page.waitForFunction(() => document.querySelector(".wb-tab.active")?.textContent.includes("drop_table"));
  await page.locator(".wb-relation-chip").filter({ hasText: "item_id = 1" }).waitFor();
  await page.waitForFunction(() => document.querySelector('.wb-grid-row td.selected')?.closest(".wb-grid-row"));
  await page.waitForFunction(() => document.querySelector(".wb-relations-row-identity")?.textContent.startsWith("id="));
  const itemIds = await page.locator('.wb-grid-row td[data-column-index="2"]').allTextContents();
  assert.ok(itemIds.length > 1 && itemIds.every((value) => value.trim() === "1"), "the tab lists only rows referencing item 1");

  // Following the drop's reference lands on the referenced item row.
  const target = panel.locator("button.wb-relation-target").first();
  await target.waitFor();
  await target.click();
  await page.waitForFunction(() => {
    const active = document.querySelector(".wb-tab.active")?.textContent || "";
    return active.includes("item") && !active.includes("drop_table");
  });
  await page.waitForFunction(() => document.querySelector(".wb-relations-row-identity")?.textContent.startsWith("id=1"));

  // Section state is remembered.
  const tableToggle = panel.locator(".wb-relation-section-toggle").filter({ hasText: "字段关联" });
  await tableToggle.click();
  assert.equal(await tableToggle.getAttribute("aria-expanded"), "false");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openTable(page, "item");
  await page.getByRole("tab", { name: /^关联/ }).click();
  const reloaded = page.locator(".wb-relations-panel .wb-relation-section-toggle").filter({ hasText: "字段关联" });
  await reloaded.waitFor();
  assert.equal(await reloaded.getAttribute("aria-expanded"), "false");
  await reloaded.click();

  // A right-click comment edit refreshes already-cached evidence. Following a
  // table mention and returning must retain the saved field comment.
  await openTable(page, "mail");
  await page.locator(".wb-relation-card").first().waitFor();
  await page.getByRole("tab", { name: /^字段/ }).click();
  const field = page.locator(".wb-schema-list article").filter({
    has: page.locator(".wb-schema-field-name").filter({ hasText: /^reward_item_id$/ }),
  });
  await field.click({ button: "right" });
  await page.locator(".wb-context-menu").getByText("编辑备注", { exact: true }).click();
  const commentDialog = page.locator(".wb-comment-edit-dialog");
  await commentDialog.locator("textarea").fill("引用 item.id；备注保存刷新验证");
  await commentDialog.locator('button[type="submit"]').click();
  await commentDialog.waitFor({ state: "hidden" });
  await page.getByRole("tab", { name: /^关联/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".wb-relation-card-evidence-icon")]
    .some((element) => element.title.includes("备注保存刷新验证")));
  await page.getByRole("tab", { name: /^字段/ }).click();
  await field.getByRole("button", { name: "item", exact: true }).click();
  await page.locator(".wb-tab").filter({ hasText: /mail/ }).first().click();
  assert.match(await field.innerText(), /备注保存刷新验证/);

  assert.deepEqual(errors, []);
  console.log("Relation page: badges, row references, evidence, table comment cards, remembered sections, comment save and reference jump passed.");
} finally {
  await browser.close();
}
