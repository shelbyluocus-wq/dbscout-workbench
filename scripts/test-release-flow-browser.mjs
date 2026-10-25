// Browser regression for the guided release workspace (demo driver): walks a
// maintenance release from the brief to the reopened servers (schedule, wait,
// automatic shutdown, restart, open), then checks the no-downtime route with a
// failed Cocos build and retry, the tools beside the steps, close/reopen,
// English copy and light/dark rendering. Run against a Vite dev server:
//   DBSCOUT_RELEASE_TEST_URL=http://127.0.0.1:1431 node scripts/test-release-flow-browser.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.DBSCOUT_RELEASE_TEST_URL || 'http://127.0.0.1:1431';
const screenshots = process.env.DBSCOUT_RELEASE_SCREENSHOTS || 'output/playwright';
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.DBSCOUT_BROWSER_CHANNEL ? { channel: process.env.DBSCOUT_BROWSER_CHANNEL } : {}) });
const errors = [];

async function openWorkbench({ theme = 'light', language = 'zh-TW', demo = {}, viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(({ theme, language, demo }) => {
    if (sessionStorage.getItem('release-test-seeded')) return;
    sessionStorage.setItem('release-test-seeded', '1');
    localStorage.setItem('dbscout_language', language);
    localStorage.setItem('dbscout_theme', theme);
    localStorage.setItem('dbscout_release_flow_v2', JSON.stringify({ schema: 2, demo: { speed: 'fast', conflicts: true, buildFailure: false, ...demo } }));
  }, { theme, language, demo });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

async function openWorkspace(page) {
  await page.locator('[data-wb-rail-id="releaseFlow"]').click();
  await page.locator('.wb-rf-dialog').waitFor();
}

function helpers(page) {
  const primary = page.locator('[data-release-primary]');
  const current = () => page.locator('[data-release-current]').getAttribute('data-release-current');
  const label = async () => (await primary.textContent()).trim();
  async function settle() {
    await page.waitForFunction(() => !document.querySelector('.wb-rf-task-running, .wb-rf-gm-task.is-running, .wb-rf-footer .wb-rf-spin'));
  }
  async function confirmIfAsked() {
    const dialog = page.locator('.wb-confirm-dialog');
    if (await dialog.waitFor({ timeout: 700 }).then(() => true, () => false)) await dialog.locator('.wb-dialog-primary').click();
  }
  // Runs the page's main action until it offers the next page.
  async function finishPage() {
    for (let guard = 0; guard < 10; guard += 1) {
      if (/^(下一步|查看結果|Next|See the result)/.test(await label())) return;
      assert.equal(await primary.isDisabled(), false, `${await current()}: "${await label()}" is disabled`);
      await primary.click();
      await confirmIfAsked();
      await settle();
    }
    throw new Error(`${await current()} never finished`);
  }
  // Nothing on the page may need a horizontal scrollbar.
  async function assertFits() {
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.wb-rf-page, .wb-rf-footer, .wb-rf-rail-scroll')]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => `${element.className}: ${element.scrollWidth} > ${element.clientWidth}`));
    assert.deepEqual(overflow, [], `${await current()} overflows`);
  }
  async function serverPhase() {
    return (await page.locator('.wb-rf-server-pill').textContent()).trim();
  }
  return { primary, current, label, settle, confirmIfAsked, finishPage, assertFits, serverPhase };
}

try {
  // A maintenance release, end to end.
  {
    const { context, page } = await openWorkbench();
    const { primary, current, label, settle, confirmIfAsked, finishPage, assertFits, serverPhase } = helpers(page);
    await openWorkspace(page);
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H3', 'the workspace opens on its heading');
    assert.equal(await primary.isDisabled(), true, 'the release needs its files confirmed first');
    await page.locator('.wb-rf-ready').click();
    await assertFits();
    await page.screenshot({ path: `${screenshots}/release-flow-overview.png`, animations: 'disabled' });
    await primary.click();
    assert.equal(await current(), 'database');

    // Overwrite, then the plan: TW closes nine items that are not due yet.
    await primary.click();
    await confirmIfAsked();
    await settle();
    assert.equal(await label(), '一鍵寫入 9 項');
    await assertFits();
    await page.screenshot({ path: `${screenshots}/release-flow-database.png`, animations: 'disabled' });
    // The open plans are a tool beside the steps and lead back here.
    await page.locator('.wb-rf-link', { hasText: '開放規劃' }).click();
    assert.equal(await current(), 'plans');
    assert.match(await label(), /返回「覆蓋同步與規劃」/);
    assert.ok(await page.locator('[data-plan-item]').count() > 0);
    await assertFits();
    await page.screenshot({ path: `${screenshots}/release-flow-plans.png`, animations: 'disabled' });
    await primary.click();
    assert.equal(await current(), 'database');
    await finishPage();
    await primary.click();

    assert.equal(await current(), 'clientSvn');
    await primary.click();
    await settle();
    await page.locator('.wb-rf-conflicts.is-pending').waitFor();
    assert.equal(await primary.isDisabled(), true, 'conflicts need a choice before continuing');
    await page.locator('.wb-rf-conflicts .wb-rf-btn', { hasText: '全部以雲端為準' }).click();
    await primary.click();
    await settle();
    assert.match(await page.locator('.wb-rf-task-line.is-success').textContent(), /已處理 2 個衝突/);
    await primary.click();

    for (const pageId of ['clientSync', 'clientTransfer', 'clientDiff', 'build', 'gmUpload']) {
      assert.equal(await current(), pageId);
      await finishPage();
      await assertFits();
      if (pageId === 'build') await page.screenshot({ path: `${screenshots}/release-flow-build.png`, animations: 'disabled' });
      await primary.click();
    }

    // Maintenance follows the server: schedule, wait, the servers close by
    // themselves, restart, then open by hand.
    assert.equal(await current(), 'gmServer');
    assert.equal(await serverPhase(), '運行中');
    assert.equal(await label(), '確認排程');
    await assertFits();
    await page.screenshot({ path: `${screenshots}/release-flow-server-schedule.png`, animations: 'disabled' });
    await primary.click();
    await settle();
    await page.waitForFunction(() => document.querySelector('.wb-rf-server-pill')?.textContent.includes('等待維護'));
    assert.equal(await primary.isDisabled(), true, 'nothing to click while waiting');
    assert.match(await page.locator('.wb-rf-server-clock').textContent(), /距離維護開始/);
    await page.screenshot({ path: `${screenshots}/release-flow-server-waiting.png`, animations: 'disabled' });
    await page.locator('.wb-rf-waiting .wb-rf-btn', { hasText: '快轉到維護時間' }).click();
    await page.waitForFunction(() => document.querySelector('.wb-rf-server-pill')?.textContent.includes('維護中'));
    await settle();
    assert.equal(await label(), '編譯並重新啟動');
    assert.match(await page.locator('.wb-rf-server-events').textContent(), /伺服器關閉，進入維護/);
    await page.screenshot({ path: `${screenshots}/release-flow-server-maintenance.png`, animations: 'disabled' });
    await primary.click();
    await confirmIfAsked();
    await settle();
    assert.equal(await label(), '開放伺服器');
    await primary.click();
    await confirmIfAsked();
    await settle();
    assert.equal(await serverPhase(), '運行中');
    assert.match(await page.locator('.wb-rf-server-title').textContent(), /伺服器已恢復運行/);
    await assertFits();
    await page.screenshot({ path: `${screenshots}/release-flow-server-restored.png`, animations: 'disabled' });
    await primary.click();

    assert.equal(await current(), 'summary');
    await page.locator('.wb-rf-summary-hero').waitFor();
    assert.match(await page.locator('.wb-rf-rail-footer').textContent(), /17 \/ 17/);
    await assertFits();
    await page.screenshot({ path: `${screenshots}/release-flow-summary.png`, animations: 'disabled' });

    // Progress survives closing the workspace.
    await page.locator('.wb-rf-close').click();
    await page.locator('.wb-rf-dialog').waitFor({ state: 'detached' });
    await openWorkspace(page);
    assert.equal(await current(), 'summary');
    await context.close();
  }

  // No downtime, client and activities only, with a failing first build.
  {
    const { context, page } = await openWorkbench({ theme: 'dark', demo: { conflicts: false, buildFailure: true } });
    const { primary, current, label, settle, finishPage, assertFits } = helpers(page);
    await openWorkspace(page);
    await page.locator('.wb-rf-segmented [role="radio"]', { hasText: '不停服更新' }).click();
    await page.locator('.wb-rf-scope', { hasText: '資料庫' }).click();
    assert.equal(await page.locator('.wb-rf-scope', { hasText: '伺服器' }).isDisabled(), true);
    assert.equal(await page.locator('[data-release-page="database"]').isDisabled(), true);
    await page.locator('.wb-rf-ready').click();
    await primary.click();
    assert.equal(await current(), 'clientSvn');
    for (let index = 0; index < 4; index += 1) {
      await finishPage();
      await primary.click();
    }
    assert.equal(await current(), 'build');
    await primary.click();
    await settle();
    assert.match(await page.locator('.wb-rf-notice.is-danger').textContent(), /結束代碼 34/);
    assert.equal(await label(), '重試');
    await assertFits();
    await page.screenshot({ path: `${screenshots}/release-flow-build-failed-dark.png`, animations: 'disabled' });
    await finishPage();
    await primary.click();
    assert.equal(await current(), 'gmUpload');
    assert.equal(await page.locator('[data-release-task="gm.activityReload"]').count(), 1, 'no downtime reloads activities');
    assert.equal(await page.locator('[data-release-task="gm.serverUpload"]').count(), 0);
    await finishPage();
    await primary.click();
    assert.equal(await current(), 'gmServer');
    assert.equal(await page.locator('.wb-rf-server-stages').count(), 0, 'no maintenance without downtime');
    await page.screenshot({ path: `${screenshots}/release-flow-server-hot-dark.png`, animations: 'disabled' });
    await finishPage();
    await primary.click();
    assert.equal(await current(), 'summary');
    await page.locator('.wb-rf-summary-hero').waitFor();
    await context.close();
  }

  // English copy at a narrower window, and the tools from the overview.
  {
    const { context, page } = await openWorkbench({ language: 'en', viewport: { width: 1280, height: 800 } });
    const { primary, current, label, assertFits } = helpers(page);
    await openWorkspace(page);
    assert.equal(await label(), 'Start release');
    await page.locator('[data-release-page="platforms"]').click();
    assert.equal(await current(), 'platforms');
    assert.equal(await label(), 'Back to This release');
    await assertFits();
    await page.locator('[data-release-page="plans"]').click();
    await assertFits();
    await page.screenshot({ path: `${screenshots}/release-flow-plans-en.png`, animations: 'disabled' });
    await primary.click();
    assert.equal(await current(), 'overview');
    const han = await page.evaluate(() => {
      const text = document.querySelector('.wb-rf-dialog').innerText;
      // Names from the game client and its database are data, not copy.
      return text.replace(/抖音|玩心|决胜\d|newsg_\w+/g, '').match(/\p{Script=Han}+/gu) || [];
    });
    assert.deepEqual(han, [], 'English copy has no Chinese text');
    await context.close();
  }

  assert.deepEqual(errors, []);
  console.log('release flow browser checks passed');
} finally {
  await browser.close();
}
