import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { RELEASE_DRAFT_KEY } from "../src/workbench/releaseWorkflowState.js";

const base = process.env.DBSCOUT_RELEASE_TEST_URL || "http://127.0.0.1:1431";
const shots = process.env.DBSCOUT_RELEASE_SCREENSHOTS || join(tmpdir(), "blackcat-release-workflow");
const capture = process.env.DBSCOUT_RELEASE_CAPTURE !== "0";
const browser = await chromium.launch({ headless: true, channel: process.env.DBSCOUT_PLAYWRIGHT_CHANNEL || undefined });
const errors = [];
const customTemplates = [{ id: "release-test", name: "Platform B conversion", scriptPath: "/demo/convert.sh", projectRoot: "/demo/platform-b", conflictStrategy: "manual" }];
await mkdir(shots, { recursive: true });

async function screenshot(page, name) {
  if (capture) await page.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" });
}

async function open(page, keyboard = false) {
  const entry = page.locator('[data-wb-rail-id="releaseWorkflow"]');
  if (keyboard) {
    await entry.focus();
    await entry.press("Enter");
  } else await entry.click();
  await page.locator(".rw-workspace").waitFor();
}

async function go(page, step) {
  await page.locator(`[data-release-step="${step}"]`).click();
  await page.waitForFunction((index) => document.querySelector(`[data-release-step="${index}"]`)?.getAttribute("aria-current") === "step", step);
}

async function run(page, action, expected = "done") {
  const row = page.locator(`[data-release-action="${action}"]`);
  await row.getByRole("button").click();
  await page.waitForFunction(({ action, expected }) => document.querySelector(`[data-release-action="${action}"]`)?.dataset.status === expected, { action, expected });
}

async function stored(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), RELEASE_DRAFT_KEY);
}

async function assertContained(page) {
  const size = await page.locator(".rw-workspace").evaluate((node) => ({
    width: node.clientWidth, scrollWidth: node.scrollWidth, right: node.getBoundingClientRect().right,
    viewport: window.innerWidth, center: document.querySelector(".rw-center").clientWidth,
    centerScroll: document.querySelector(".rw-center").scrollWidth,
  }));
  assert.ok(size.scrollWidth <= size.width + 1, JSON.stringify(size));
  assert.ok(size.right <= size.viewport + 1, JSON.stringify(size));
  assert.ok(size.centerScroll <= size.center + 1, JSON.stringify(size));
  const footer = await page.locator(".rw-footer").boundingBox();
  assert.ok(footer.y + footer.height <= page.viewportSize().height + 1, "primary action remains in the viewport");
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  page.setDefaultTimeout(12_000);
  page.on("pageerror", (error) => errors.push(error.message));
  const writes = [];
  page.on("request", (request) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
  });
  await page.addInitScript(({ key, templates }) => {
    if (sessionStorage.getItem("release-test-seeded")) return;
    sessionStorage.setItem("release-test-seeded", "1");
    localStorage.setItem("dbscout_language", "zh-CN");
    localStorage.setItem("dbscout_theme", "light");
    localStorage.setItem("dbscout_table_transfer_templates", JSON.stringify(templates));
    localStorage.removeItem(key);
  }, { key: RELEASE_DRAFT_KEY, templates: customTemplates });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await open(page);
  const primary = page.locator("[data-release-primary]");
  assert.equal(await primary.isDisabled(), true);
  assert.match(await page.locator(".rw-safety").textContent(), /不会写数据库/);
  await assertContained(page);
  await screenshot(page, "01-prepare-desktop");

  // Browsing later stages is allowed, but execution is dependency-gated.
  await go(page, 5);
  assert.equal(await primary.isDisabled(), true);
  assert.equal(await page.locator('[data-release-action="open"] button').isDisabled(), true);
  await go(page, 0);
  await page.getByRole("checkbox", { name: /需要更新的文件和配置/ }).check();
  await primary.click();
  await page.locator('[data-release-action="preflight"][data-status="running"]').waitFor();
  await primary.click();
  await page.locator('[data-release-action="preflight"][data-status="cancelled"]').waitFor();
  await primary.click();
  await page.locator('[data-release-action="preflight"][data-status="running"]').waitFor();
  await page.locator(".rw-leave").click();
  await open(page);
  assert.equal(await page.locator('[data-release-action="preflight"]').getAttribute("data-status"), "cancelled");
  await run(page, "preflight");
  await primary.click();

  const targetDb = page.getByLabel("目标数据库", { exact: true });
  await targetDb.fill("development_cfg");
  assert.equal(await primary.isDisabled(), true);
  await targetDb.fill("platform_b_cfg");
  await page.getByLabel("开放对象 1", { exact: true }).fill("演示英雄 A");
  await page.getByLabel("自定义备注 1", { exact: true }).fill("仅为备注，不执行任何写库指令");
  await run(page, "dbPreview");
  assert.equal(await primary.isDisabled(), true);
  await page.getByRole("checkbox", { name: /我已核对目标库/ }).check();
  await screenshot(page, "02-database-desktop");
  await run(page, "dbApply");
  await primary.click();

  await page.getByLabel("转表模板", { exact: false }).and(page.locator("select")).selectOption("release-test");
  assert.match(await page.locator(".rw-content").textContent(), /\/demo\/convert\.sh/);
  assert.match(await page.locator(".rw-file-list").textContent(), /\.svn\/wc\.db\s*已排除/);
  await page.getByRole("checkbox", { name: "演示 SVN 冲突", exact: true }).check();
  await run(page, "svn", "blocked");
  assert.equal(await primary.isDisabled(), true);
  assert.equal(await page.locator('[data-release-action="copy"] button').isDisabled(), true);
  await screenshot(page, "03-conflict-desktop");
  await page.getByLabel("assets/scripts/Channel.ts", { exact: true }).selectOption("remote");
  assert.equal(await primary.isDisabled(), true);
  await page.getByLabel("settings/platform.json", { exact: true }).selectOption("local");
  await run(page, "svn");
  await run(page, "copy");
  await run(page, "transfer");
  assert.equal(await primary.isDisabled(), true);
  await page.getByRole("checkbox", { name: /我已检查差异/ }).check();
  await run(page, "diff");
  await primary.click();

  await page.getByLabel("Creator 版本").and(page.locator("select")).selectOption("2.4.15");
  assert.match(await page.locator(".rw-command").textContent(), /--path/);
  await page.getByLabel("Creator 版本").and(page.locator("select")).selectOption("3.8.8");
  assert.match(await page.locator(".rw-command").textContent(), /--project/);
  await page.getByRole("checkbox", { name: /演示一次打包失败/ }).check();
  await run(page, "build", "failed");
  assert.match(await page.locator('[role="alert"]').textContent(), /模拟失败/);
  await screenshot(page, "04-build-failure-desktop");
  await run(page, "build");
  assert.match(await page.locator(".rw-artifact").textContent(), /client_b_.*\.zip/);
  await primary.click();

  await page.getByRole("checkbox", { name: /额外立即重读活动/ }).check();
  for (const action of ["activityUpload", "activityCurrent", "activityReload", "clientUpload", "serverUpload", "serverCurrent"]) await run(page, action);
  const date = (await stored(page)).drafts.b.config.date;
  await page.getByLabel("客户端更新开放时间", { exact: true }).fill(`${date}T08:00`);
  assert.equal(await primary.isDisabled(), true);
  assert.match(await page.locator(".rw-error").textContent(), /不能早于/);
  await page.getByLabel("客户端更新开放时间", { exact: true }).fill(`${date}T10:05`);
  await run(page, "schedule");
  await screenshot(page, "05-gm-desktop");
  await primary.click();
  for (const action of ["maintenance", "restart", "health"]) await run(page, action);
  assert.equal(await primary.isDisabled(), true);
  await page.getByRole("checkbox", { name: /允许开服/ }).check();
  await run(page, "open");
  await page.locator(".rw-finished").waitFor();
  await screenshot(page, "06-finished-desktop");

  const downloadPromise = page.waitForEvent("download");
  await primary.click();
  const download = await downloadPromise;
  const report = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(report.demo, true);
  assert.equal(report.realOperationsExecuted, false);
  assert.equal(report.results.open, "done");
  assert.equal(report.config.templateId, "release-test");
  assert.match(download.suggestedFilename(), /^release-DEMO-b-/);
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem("dbscout_table_transfer_templates"))), customTemplates);
  assert.deepEqual(writes, [], "the rehearsal must not send network write requests");

  // Completed stages and platform-specific drafts survive remount and reload.
  await page.locator(".rw-leave").click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await open(page);
  await page.locator(".rw-finished").waitFor();
  await page.locator(".rw-sidebar select").selectOption("c");
  assert.equal(await primary.isDisabled(), true);
  await go(page, 0);
  await page.getByLabel("本次版本", { exact: true }).fill("platform-c-draft");
  await page.locator(".rw-sidebar select").selectOption("b");
  assert.equal(await page.getByLabel("本次版本", { exact: true }).inputValue(), report.config.version);
  await page.getByLabel("本次版本", { exact: true }).fill("updated-version");
  assert.match(await page.locator('.rw-workspace [role="status"]').textContent(), /后续结果已作废/);
  assert.deepEqual((await stored(page)).drafts.b.results, {});
  assert.equal((await stored(page)).drafts.c.config.version, "platform-c-draft");

  // The rail intentionally blurs pointer clicks; keyboard opening retains a return target.
  await page.locator(".rw-leave").click();
  await open(page, true);
  // Nested confirmation owns Escape. Cancelling it must not close the workspace.
  const resetButton = page.locator(".rw-context-tools").getByRole("button", { name: "重新演练", exact: true });
  await resetButton.click();
  await page.getByRole("alertdialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  assert.equal(await page.locator(".rw-workspace").count(), 1);
  assert.equal(await page.getByLabel("本次版本", { exact: true }).inputValue(), "updated-version");
  await resetButton.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "重新演练", exact: true }).click();
  assert.equal((await stored(page)).drafts.b.logs.length, 0);
  assert.equal((await stored(page)).drafts.c.config.version, "platform-c-draft");

  for (let i = 0; i < 16; i += 1) {
    await page.keyboard.press("Tab");
    assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest(".rw-workspace"))), "focus stays in the workflow");
  }
  await page.keyboard.press("Escape");
  await page.locator(".rw-workspace").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.wbRailId), "releaseWorkflow");

  // Theme/language variants share the app's existing controllers and tokens.
  await page.evaluate(() => {
    localStorage.setItem("dbscout_theme", "dark");
    localStorage.setItem("dbscout_language", "en");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await open(page);
  assert.equal(await page.locator("#rw-title").textContent(), "Release workspace");
  await screenshot(page, "07-dark-english-desktop");
  await assertContained(page);
  await page.locator(".rw-leave").click();
  await page.evaluate(() => {
    localStorage.setItem("dbscout_theme", "light");
    localStorage.setItem("dbscout_language", "zh-TW");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await open(page);
  await assertContained(page);
  await screenshot(page, "08-prepare-mobile");
  assert.ok(await page.locator(".rw-compact-tools").getByRole("button", { name: "匯出演練紀錄" }).isVisible());
  for (const step of [1, 2, 3, 4, 5]) {
    await go(page, step);
    await assertContained(page);
    assert.doesNotMatch(await page.locator(".rw-workspace").textContent(), /release\.[A-Za-z_]+/);
    if (step === 1) await screenshot(page, "09-database-mobile");
  }

  const unavailable = await browser.newPage({ viewport: { width: 390, height: 844 } });
  unavailable.on("pageerror", (error) => errors.push(error.message));
  await unavailable.addInitScript((key) => {
    localStorage.setItem("dbscout_language", "zh-CN");
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (name) { if (name === key) throw new Error("storage unavailable"); return get.call(this, name); };
    Storage.prototype.setItem = function (name, value) { if (name === key) throw new Error("storage unavailable"); return set.call(this, name, value); };
  }, RELEASE_DRAFT_KEY);
  await unavailable.goto(base, { waitUntil: "domcontentloaded" });
  await open(unavailable);
  assert.match(await unavailable.locator(".rw-storage-warning").textContent(), /保存不可用/);
  await assertContained(unavailable);
  assert.deepEqual(errors, [], "no uncaught browser errors");
  console.log("Release workflow browser regression passed: full flow, gates, recovery, persistence, export, keyboard, themes, languages and narrow layouts.");
  if (capture) console.log(`Screenshots: ${shots}`);
} finally {
  await browser.close();
}
