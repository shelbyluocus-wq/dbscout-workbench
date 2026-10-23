// Replay a private audited export through the actual workbench UI. Only the
// isolated browser's mock catalog is replaced; no database writes or fixtures
// containing production rows are added to the repository.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { parseReferenceValues } from "../src/workbench/utils/referenceParser.js";

const directory = process.argv[2];
if (!directory) throw new Error("Pass the private export directory");
const read = async (file) => JSON.parse(await readFile(join(directory, file), "utf8"));
const audit = await read("relations-audit.json");
const names = ["goodsprop", "boxprop", "heroprop", "goodssourceprop", "shoptypeprop"];
const tables = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await read(`${name}.json`)])));
const relations = audit.relations.map((entry) => entry.relation)
  .filter((view) => names.includes(view.sourceTable) && names.includes(view.targetTable));
const rewardRelation = relations.find((view) => view.sourceTable === "boxprop" && view.sourceColumn === "ItemCfg" && view.targetTable === "goodsprop");
assert.ok(rewardRelation);
const wanted = "11007";
const expectedBoxes = tables.boxprop.rows.filter((row) => parseReferenceValues(row.ItemCfg, rewardRelation.parser)?.includes(wanted));
assert.ok(expectedBoxes.length > 0);

const browser = await chromium.launch({ headless: true, channel: process.env.DBSCOUT_PLAYWRIGHT_CHANNEL || undefined });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((fixture) => {
    globalThis.__CONFIG_AUDIT__ = fixture;
    localStorage.setItem("dbscout_language", "zh-CN");
  }, { tables, relations });
  const patchModule = async (pattern, transform) => page.route(pattern, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: transform(await response.text()) });
  });
  await patchModule("**/src/workbench/mock/mockSchema.js*", (source) => {
    const marker = "export const mockSchema =";
    assert.ok(source.includes(marker));
    return source.replace(marker, `
      for (const [name, table] of Object.entries(globalThis.__CONFIG_AUDIT__.tables)) {
        mockTableDefs[name] = { table_name: name, table_comment: table.schema.tableComment || "", columns:
          table.schema.columns.map(c => ({ column_name: c.columnName, column_type: c.columnType,
            column_comment: c.columnComment, is_primary_key: c.isPrimaryKey, is_nullable: c.isNullable })) };
      }
      for (const id of ["demo", "demo-staging", "demo-test"]) {
        mockDatabaseSchemas[id + "/game_db"] = Object.keys(globalThis.__CONFIG_AUDIT__.tables);
      }
      ${marker}`);
  });
  await patchModule("**/src/workbench/mock/mockRows.js*", (source) => `${source}
    for (const [name, table] of Object.entries(globalThis.__CONFIG_AUDIT__.tables)) {
      for (const id of ["demo", "demo-staging", "demo-test"]) rowCache.set(id + "/game_db/" + name, table.rows);
    }`);
  await patchModule("**/src/workbench/mock/mockConfigRelations.js*", (source) => {
    const marker = "views.sort((left, right) => left.id.localeCompare(right.id));";
    assert.ok(source.includes(marker));
    return source.replace(marker, `views.splice(0, views.length, ...globalThis.__CONFIG_AUDIT__.relations); ${marker}`);
  });
  const calls = [];
  await page.exposeFunction("recordAuditCall", (command, payload) => calls.push({ command, payload }));
  await patchModule("**/src/workbench/utils/tauriBridge.js*", (source) => {
    const marker = "export async function invokeWorkbench(command, payload = {}) {";
    assert.ok(source.includes(marker));
    return source.replace(marker, `${marker}
      if (command === "open_table_session") globalThis.recordAuditCall(command, payload);
    `);
  });
  await page.goto(process.env.DBSCOUT_RELATIONS_TEST_URL || "http://127.0.0.1:1431", { waitUntil: "domcontentloaded" });
  await page.locator('[role="option"]').filter({ hasText: /^goodsprop\b/ }).dblclick();
  await page.locator('.wb-grid-row td[data-column-index="0"]').first().waitFor();
  await page.locator(".wb-grid-wrap").evaluate((element, rowIndex) => {
    element.scrollTop = rowIndex * 28;
    element.dispatchEvent(new Event("scroll"));
  }, tables.goodsprop.rows.findIndex((row) => row.ID === wanted));
  await page.locator('.wb-grid-row td[data-column-index="0"]').filter({ hasText: new RegExp(`^${wanted}$`) }).first().click();
  await page.getByRole("tab", { name: /^关联/ }).click();
  const panel = page.locator(".wb-relations-panel");
  const reward = panel.locator(".wb-incoming-relation").filter({ hasText: "boxprop.ItemCfg" });
  await reward.getByText(`${expectedBoxes.length} 行`, { exact: true }).waitFor();
  assert.equal(await reward.locator(".wb-incoming-key").count(), 0);
  await reward.locator(".wb-incoming-toggle").click();
  await reward.locator(".wb-incoming-key").first().waitFor();
  const coldKeys = await reward.locator(".wb-incoming-key").allTextContents();
  assert.equal(coldKeys.length, Math.min(50, expectedBoxes.length));
  await reward.locator(".wb-incoming-toggle").click();
  await reward.locator(".wb-incoming-toggle").click();
  assert.deepEqual(await reward.locator(".wb-incoming-key").allTextContents(), coldKeys);
  while (await reward.locator(".wb-incoming-more").count()) {
    const before = await reward.locator(".wb-incoming-key").count();
    await reward.locator(".wb-incoming-more").click();
    await page.waitForFunction((before) => document.querySelectorAll(".wb-incoming-key").length > before, before);
  }
  assert.equal(await reward.locator(".wb-incoming-key").count(), expectedBoxes.length);
  await page.screenshot({ path: join(directory, "goods-box-incoming.png") });
  await reward.locator(".wb-incoming-open").click();
  await page.waitForFunction(() => document.querySelector(".wb-row-target-column[title='BoxID']"));
  const allCall = calls.findLast((call) => call.payload.tableName === "boxprop" && call.payload.options?.filter?.relation?.column === "ItemCfg");
  assert.ok(allCall, "open all carries the reward parser into the normal table session");
  assert.deepEqual(allCall.payload.options.filter.relation.parser, rewardRelation.parser);
  assert.deepEqual(allCall.payload.options.filter.relation.values, [wanted]);
  const boxIdentity = panel.locator(".wb-row-target").filter({ has: page.locator(".wb-row-target-column[title='BoxID']") });
  const boxId = (await boxIdentity.locator(".wb-relation-target-value").first().innerText()).trim();
  assert.ok(expectedBoxes.some((row) => row.BoxID === boxId));
  await boxIdentity.locator(".wb-relation-target.is-found").first().click();
  await page.waitForFunction((id) => document.querySelector('.wb-grid-row td[data-column-index="0"].selected')?.textContent.trim() === id, boxId);
  const incomingIdentity = panel.locator(".wb-incoming-relation").filter({ hasText: "boxprop.BoxID" });
  await incomingIdentity.getByText("1 行", { exact: true }).waitFor();
  await incomingIdentity.locator(".wb-incoming-toggle").click();
  await incomingIdentity.locator(".wb-incoming-row").first().click();
  await page.waitForFunction(() => document.querySelector(".wb-row-target-column[title='BoxID']"));
  assert.deepEqual(errors, []);
  const result = { goodsId: wanted, boxId, referencingBoxes: expectedBoxes.length,
    checks: ["reward incoming count", "cold/warm expansion", "all pages", "filtered tab parser",
      "box identity outgoing jump", "goods identity incoming jump", "selected row after jump"], errors };
  await writeFile(join(directory, "browser-verification.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    await writeFile(join(directory, "browser-failure.txt"), await page.locator("body").innerText());
    await page.screenshot({ path: join(directory, "browser-failure.png") });
    console.error(errors);
  }
  throw error;
} finally {
  await browser.close();
}
