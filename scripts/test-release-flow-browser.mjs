// Browser regression for the guided release workspace (demo driver): walks a
// maintenance release from the brief to the open servers, then checks the
// no-downtime route, a failed Cocos build with retry, close/reopen and
// light/dark rendering. Run against a Vite dev server:
//   DBSCOUT_RELEASE_TEST_URL=http://127.0.0.1:1431 node scripts/test-release-flow-browser.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.DBSCOUT_RELEASE_TEST_URL || 'http://127.0.0.1:1431';
const screenshots = process.env.DBSCOUT_RELEASE_SCREENSHOTS || 'output/playwright';
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.DBSCOUT_BROWSER_CHANNEL ? { channel: process.env.DBSCOUT_BROWSER_CHANNEL } : {}) });
const errors = [];

async function openWorkbench({ theme = 'light', demo = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(({ theme, demo }) => {
    if (sessionStorage.getItem('release-test-seeded')) return;
    sessionStorage.setItem('release-test-seeded', '1');
    localStorage.setItem('dbscout_language', 'zh-TW');
    localStorage.setItem('dbscout_theme', theme);
    localStorage.setItem('dbscout_release_flow_v1', JSON.stringify({ schema: 1, demo: { speed: 'fast', conflicts: true, buildFailure: false, ...demo } }));
  }, { theme, demo });
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
  async function settle() {
    await page.waitForFunction(() => !document.querySelector('.wb-rf-task-running, .wb-rf-gm-task.is-running'));
  }
  async function confirmIfAsked() {
    const dialog = page.locator('.wb-confirm-dialog');
    if (await dialog.waitFor({ timeout: 700 }).then(() => true, () => false)) await dialog.locator('.wb-dialog-primary').click();
  }
  // Runs the page's main action until it offers the next page.
  async function finishPage() {
    for (let guard = 0; guard < 10; guard += 1) {
      const label = (await primary.textContent()).trim();
      if (/^(下一步|查看更新結果)/.test(label)) return;
      assert.equal(await primary.isDisabled(), false, `${await current()}: "${label}" is disabled`);
      await primary.click();
      await confirmIfAsked();
      await settle();
    }
    throw new Error(`${await current()} never finished`);
  }
  return { primary, current, settle, finishPage };
}

try {
  // A maintenance release, end to end.
  {
    const { context, page } = await openWorkbench();
    const { primary, current, settle, finishPage } = helpers(page);
    await openWorkspace(page);
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H3', 'the workspace opens on its heading');
    assert.equal(await primary.isDisabled(), true, 'the release needs its files confirmed first');
    await page.locator('.wb-rf-prepared').click();
    await primary.click();
    assert.equal(await current(), 'dbSync');

    await finishPage();
    await primary.click();
    assert.equal(await current(), 'dbPlans');
    assert.equal((await primary.textContent()).trim(), '一鍵寫入 13 處變更');
    assert.equal(await page.locator('[data-plan-category="hero"] .wb-rf-plan-badge').textContent(), '3');
    await finishPage();
    assert.equal(await page.locator('.wb-rf-plan-badge').count(), 0, 'a written plan leaves nothing to change');
    assert.equal(await page.locator('.wb-rf-plan-write.is-written').count(), 3, 'written hero rows read as closed');
    await page.screenshot({ path: `${screenshots}/release-flow-plans.png` });
    await primary.click();

    assert.equal(await current(), 'clientSvn');
    await primary.click();
    await settle();
    await page.locator('.wb-rf-conflicts.is-pending').waitFor();
    assert.equal(await primary.isDisabled(), true, 'conflicts need a choice before continuing');
    await page.locator('.wb-rf-conflicts .wb-rf-ghost', { hasText: '全部以雲端為準' }).click();
    await primary.click();
    await settle();
    assert.match(await page.locator('.wb-rf-notice.is-success').textContent(), /已處理 2 個衝突/);
    await primary.click();

    for (const pageId of ['clientSync', 'clientTransfer', 'clientDiff', 'build', 'gmUpload', 'gmSchedule', 'gmLaunch']) {
      assert.equal(await current(), pageId);
      await finishPage();
      await primary.click();
    }
    assert.equal(await current(), 'summary');
    await page.locator('.wb-rf-summary-hero').waitFor();
    assert.match(await page.locator('.wb-rf-rail-footer').textContent(), /16 \/ 16/);
    await page.screenshot({ path: `${screenshots}/release-flow-summary.png` });

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
    const { primary, current, settle, finishPage } = helpers(page);
    await openWorkspace(page);
    await page.locator('.wb-rf-segmented [role="radio"]', { hasText: '不停服更新' }).click();
    await page.locator('.wb-rf-scope', { hasText: '資料庫' }).click();
    assert.equal(await page.locator('.wb-rf-scope', { hasText: '伺服器' }).locator('input').isDisabled(), true);
    assert.equal(await page.locator('[data-release-page="gmLaunch"]').isDisabled(), true);
    assert.equal(await page.locator('[data-release-page="dbSync"]').isDisabled(), true);
    await page.locator('.wb-rf-prepared').click();
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
    assert.equal((await primary.textContent()).trim(), '重試');
    await page.screenshot({ path: `${screenshots}/release-flow-build-failed-dark.png` });
    await finishPage();
    await primary.click();
    assert.equal(await current(), 'gmUpload');
    assert.equal(await page.locator('[data-release-task="gm.activityReload"]').count(), 1, 'no downtime reloads activities');
    assert.equal(await page.locator('[data-release-task="gm.serverUpload"]').count(), 0);
    await finishPage();
    await primary.click();
    assert.equal(await current(), 'gmSchedule');
    await finishPage();
    await primary.click();
    assert.equal(await current(), 'summary');
    await page.locator('.wb-rf-summary-hero').waitFor();
    await context.close();
  }

  assert.deepEqual(errors, []);
  console.log('release flow browser checks passed');
} finally {
  await browser.close();
}
