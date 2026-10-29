// Browser regression for the release workspace (demo driver, mock backend):
// the platform board and overview, a maintenance update from the brief to the
// reopened servers (backup and restore, the open-plan memo, picked exclusion
// rules, a template made on the transfer step, the side-by-side diff with a
// commit, the build confirmation), the history, continuing and abandoning
// updates, the standalone build and SVN pages, reopening, English copy,
// light/dark rendering, and a one-click run of a whole update by its rules.
// Run against a Vite dev server:
//   DBSCOUT_RELEASE_TEST_URL=http://127.0.0.1:1431 node scripts/test-release-flow-browser.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.DBSCOUT_RELEASE_TEST_URL || 'http://127.0.0.1:1431';
const screenshots = process.env.DBSCOUT_RELEASE_SCREENSHOTS || 'output/playwright';
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.DBSCOUT_BROWSER_CHANNEL ? { channel: process.env.DBSCOUT_BROWSER_CHANNEL } : {}) });
const errors = [];
const STORAGE_KEYS = ['dbscout_release_flow_v2', 'dbscout_release_flow_v3', 'dbscout_release_history_v1'];

async function openWorkbench({ theme = 'light', language = 'zh-TW', viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' || /Vue warn/.test(message.text())) errors.push(message.text()); });
  await page.addInitScript(({ theme, language, keys }) => {
    if (sessionStorage.getItem('release-test-seeded')) return;
    sessionStorage.setItem('release-test-seeded', '1');
    localStorage.setItem('dbscout_language', language);
    localStorage.setItem('dbscout_theme', theme);
    for (const key of keys) localStorage.removeItem(key);
  }, { theme, language, keys: STORAGE_KEYS });
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
  const card = (platformId) => page.locator(`[data-release-platform="${platformId}"]`);
  async function settle() {
    await page.waitForFunction(() => !document.querySelector('.wb-rf-task-running, .wb-rf-gm-task.is-running, .wb-rf-footer .wb-rf-spin'), null, { timeout: 40_000 });
  }
  async function confirm({ expect = null } = {}) {
    const dialog = page.locator('.wb-confirm-dialog');
    await dialog.waitFor();
    if (expect) assert.match(await dialog.textContent(), expect);
    await dialog.locator('.wb-dialog-primary').click();
    await dialog.waitFor({ state: 'detached' });
  }
  async function confirmIfAsked() {
    const dialog = page.locator('.wb-confirm-dialog');
    if (await dialog.waitFor({ timeout: 900 }).then(() => true, () => false)) await dialog.locator('.wb-dialog-primary').click();
  }
  // Runs the page's main action until it offers the next page.
  async function finishPage() {
    for (let guard = 0; guard < 12; guard += 1) {
      if (/^(下一步|查看結果|Next|See the result)/.test(await label())) return;
      assert.equal(await primary.isDisabled(), false, `${await current()}: "${await label()}" is disabled`);
      await primary.click();
      await confirmIfAsked();
      await settle();
    }
    throw new Error(`${await current()} never finished`);
  }
  // Nothing in the workspace may need a horizontal scrollbar.
  async function assertFits(where) {
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.wb-rf-page, .wb-rf-footer, .wb-rf-board-scroll, .wb-rf-header')]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => `${element.className}: ${element.scrollWidth} > ${element.clientWidth}`));
    assert.deepEqual(overflow, [], `${where} overflows`);
  }
  async function newUpdate(platformId) {
    await page.locator('[data-release-new-update]').click();
    await page.locator(`[data-release-choice="${platformId}"]`).click();
  }
  async function shot(name) {
    await page.screenshot({ path: `${screenshots}/release-${name}.png`, animations: 'disabled' });
  }
  return { primary, current, label, card, settle, confirm, confirmIfAsked, finishPage, assertFits, newUpdate, shot };
}

try {
  // The board, a maintenance update end to end, the history.
  {
    const { context, page } = await openWorkbench();
    const h = helpers(page);
    const { primary, current, label, card, settle, confirm, finishPage, assertFits, newUpdate, shot } = h;
    await openWorkspace(page);
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H3', 'the workspace opens on its heading');
    assert.equal(await page.locator('.wb-rf-note').count(), 4, 'one note per platform');
    assert.match(await card('wanxin').textContent(), /待更新/, 'the demo schedules 玩心');
    assert.match(await card('douyin').textContent(), /已完成/);
    assert.ok(await page.locator('.wb-rf-history-list .wb-rf-history-row').count() >= 3, 'the overview shows recent records');
    await assertFits('overview');
    await shot('home');

    // Fast demo, no conflicts, two files missing in the sync.
    await page.locator('button[aria-controls="wb-rf-demo-menu"]').click();
    await page.locator('#wb-rf-demo-menu [role="radio"]').nth(1).click();
    await page.locator('#wb-rf-demo-menu label', { hasText: 'SVN 更新時出現衝突' }).locator('input').uncheck();
    await page.locator('#wb-rf-demo-menu label', { hasText: '缺少兩個檔案' }).locator('input').check();
    await page.keyboard.press('Escape');
    await page.locator('.wb-rf-dialog').waitFor();

    await newUpdate('tw');
    await page.locator('[data-release-create]').click();
    assert.equal(await current(), 'brief');
    assert.equal(await primary.isDisabled(), true, 'the update starts once its files are ready');
    await page.locator('.wb-rf-ready input').check();
    await primary.click();
    assert.equal(await current(), 'database');
    assert.match(await card('tw').textContent(), /更新中/);

    // Kept tables: the suggestion list filters, arrows move, Enter keeps one.
    const combo = page.locator('.wb-rf-combobox input');
    await combo.fill('heropro');
    await page.locator('.wb-rf-combobox-list').waitFor();
    await combo.press('Enter');
    assert.ok(await page.locator('.wb-rf-chip', { hasText: 'heroprop' }).count() >= 1, 'the suggestion is kept');
    await page.locator('.wb-rf-chip', { hasText: 'heroprop' }).locator('button').click();
    assert.equal(await page.getByText('保留開放規劃表').count(), 0, 'no "keep plan tables" option');

    await primary.click();
    await confirm({ expect: /newsg_tw_cfg/ });
    await settle();
    await page.locator('[data-release-restore]').waitFor();
    await page.locator('[data-release-restore]').click();
    await confirm({ expect: /336/ });
    await settle();
    assert.match(await page.locator('.wb-rf-backup').textContent(), /已還原/);
    assert.equal(await label(), '開始覆蓋同步', 'a restore asks for the overwrite again');
    await primary.click();
    await confirm();
    await settle();

    // Open plans are a page of their own; back returns to the step.
    await page.locator('[data-release-open-plans]').click();
    assert.equal(await page.locator('main.wb-rf-main').getAttribute('data-release-section'), 'plans');
    await page.locator('[data-plan-add]').click();
    await page.locator('[data-plan-name]').fill('測試英雄');
    await page.locator('[data-plan-ref]').fill('1099');
    await page.locator('.wb-rf-plan-editor-table tbody tr').last().locator('input').last().fill('10/24 開放');
    await page.locator('[data-plan-save]').click();
    assert.ok(await page.locator('[data-plan-item]', { hasText: '測試英雄' }).count() === 1, 'the new entry is listed');
    await assertFits('plans');
    await shot('plans');
    await page.locator('[data-release-back]').click();
    assert.equal(await current(), 'database', 'back returns to the step the person was on');
    await finishPage();
    await primary.click();

    await finishPage();
    await primary.click();
    assert.equal(await current(), 'clientSync');

    // Exclusion rules from the file dialog: inside the client only.
    await page.evaluate(() => { globalThis.__dbscoutMockPick = 'D:\\jswz\\chengxu\\client\\jswz\\assets\\bundles\\activity'; });
    await page.locator('[data-release-add-rule]').click();
    await page.locator('[data-release-pick="folder"]').click();
    await page.locator('[data-rule="assets/bundles/activity/"]').waitFor();
    assert.match(await page.locator('[data-rule="assets/bundles/activity/"]').textContent(), /資料夾及內容/);
    await page.evaluate(() => { globalThis.__dbscoutMockPick = 'C:\\Windows\\win.ini'; });
    await page.locator('[data-release-add-rule]').click();
    await page.locator('[data-release-pick="file"]').click();
    assert.match(await page.locator('.wb-rf-files-grid .wb-rf-notice').textContent(), /只能排除客戶端資料夾內/);
    await page.evaluate(() => { globalThis.__dbscoutMockPick = null; });
    await finishPage();
    assert.match(await card('tw').textContent(), /同步缺少 2 個檔案/, 'missing files show on the card');
    await primary.click();

    // A template made here is shared with one-click transfer.
    await page.locator('[data-release-new-template]').click();
    await page.locator('.wb-rf-template-new input').fill('TW 轉表測試');
    await page.locator('.wb-rf-template-new button[type="submit"]').click();
    assert.equal(await page.locator('[role="radio"][aria-checked="true"].wb-rf-template').textContent().then((text) => text.includes('TW 轉表測試')), true);
    await page.locator('.wb-rf-template-detail [role="radio"]', { hasText: '以本機為準' }).click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dbscout_table_transfer_templates') || '[]').some((template) => template.name === 'TW 轉表測試' && template.conflictStrategy === 'mine')), true);
    await finishPage();
    assert.ok(await page.locator('.wb-rf-task-panel .wb-rf-log').count() >= 1, 'the conversion log stays open');
    await primary.click();

    // The diff step: side by side, then a (simulated) commit.
    assert.equal(await current(), 'clientDiff');
    await page.locator('.wb-rf-split-row').first().waitFor();
    assert.ok(await page.locator('.wb-rf-split-text.is-added').count() > 0);
    await page.locator('.wb-rf-split-tools [role="radio"]', { hasText: '合併' }).click();
    assert.ok(await page.locator('.wb-rf-split-line').count() > 0, 'the unified layout');
    await page.locator('.wb-rf-split-tools [role="radio"]', { hasText: '並排' }).click();
    await assertFits('diff');
    await shot('diff');
    const changesBefore = await page.locator('.wb-rf-svn-entry').count();
    await page.locator('.wb-rf-svn-entry input').first().uncheck();
    await page.locator('.wb-rf-svn-message').fill('同步 TW 客戶端');
    await page.locator('[data-svn-commit]').click();
    await confirm({ expect: /演示/ });
    await page.waitForFunction((count) => document.querySelectorAll('.wb-rf-svn-entry').length === count, 1);
    assert.equal(changesBefore, 7);
    await finishPage();
    await primary.click();

    // The build step confirms what it builds and where it writes.
    assert.equal(await current(), 'build');
    await primary.click();
    await confirm({ expect: /build\\android/ });
    await settle();
    assert.match(await page.locator('.wb-rf-task-panel').last().textContent(), /模擬結果/, 'a simulated build says so');
    await assertFits('build');
    await primary.click();

    // Everything the GM can prepare is ready before the maintenance is scheduled.
    assert.equal(await current(), 'gmUpload');
    assert.equal(await page.locator('[data-release-task]').count(), 8, 'config, activity, hot update and server');
    await finishPage();
    await primary.click();
    assert.equal(await current(), 'gmServer');
    await primary.click();
    await page.locator('button', { hasText: '快轉到維護時間' }).click();
    await settle();
    // During the downtime: apply the server and config versions, start the zones, open.
    assert.deepEqual(
      await page.locator('[data-release-task]').evaluateAll((cards) => cards.map((card) => card.dataset.releaseTask)),
      ['gm.serverApply', 'gm.configApply', 'gm.restart', 'gm.open'],
    );
    await primary.click();
    await settle();
    await primary.click();
    await confirm({ expect: /配置版本 #42/ });
    await settle();
    await primary.click();
    await confirm({ expect: /玩家仍無法進入/ });
    await settle();
    await primary.click();
    await confirm();
    await settle();
    assert.equal(await label(), '查看結果', 'a finished update shows its result first');
    await primary.click();
    assert.equal(await current(), 'summary');
    assert.equal(await label(), '建立新更新');
    assert.match(await card('tw').textContent(), /已完成/);
    await shot('summary');

    await page.locator('.wb-rf-nav [data-release-section="history"]').click();
    const newest = page.locator('.wb-rf-history-days .wb-rf-history-row').first();
    assert.match(await newest.textContent(), /TW/);
    assert.match(await page.locator('.wb-rf-history-detail').textContent(), /完成 22\/22 步/);
    assert.match(await page.locator('.wb-rf-history-detail').textContent(), /缺少：/, 'warnings are kept with the step');
    await assertFits('history');
    await shot('history');

    // Continue or abandon: a platform keeps one open update.
    await newUpdate('tap');
    await page.locator('[data-release-create]').click();
    await page.locator('.wb-rf-ready input').check();
    await primary.click();
    await newUpdate('tap');
    await page.locator('[data-release-continue]').waitFor();
    await page.locator('button', { hasText: '放棄並重新建立' }).click();
    await confirm({ expect: /放棄/ });
    assert.equal(await current(), 'brief', 'a fresh update of TAP opens');
    await page.locator('.wb-rf-nav [data-release-section="history"]').click();
    assert.match(await page.locator('.wb-rf-history-days').textContent(), /已放棄/);

    // The standalone build page asks before building outside an update.
    await page.locator('.wb-rf-nav [data-release-section="build"]').click();
    await page.locator('[data-build-target="douyin"]').click();
    await page.locator('[data-build-start]').click();
    await confirm({ expect: /目前尚未執行完整的版本更新流程，確定要直接打包客戶端嗎？/ });
    await page.waitForFunction(() => !document.querySelector('[data-build-stop]'), null, { timeout: 20_000 });
    assert.match(await page.locator('.wb-rf-main').textContent(), /打包成功/);
    await assertFits('build page');

    // The SVN page: resolve a conflict, revert a file, read the log.
    await page.locator('.wb-rf-nav [data-release-section="svn"]').click();
    await page.locator('[data-svn-path="assets/resources/version.manifest"] button').first().click();
    await page.locator('.wb-rf-svn-resolve button', { hasText: '使用傳入的版本' }).click();
    await confirm();
    await page.locator('[data-svn-path="assets/resources/version.manifest"]').waitFor({ state: 'detached' });
    await page.locator('[data-svn-revert]').click();
    await confirm({ expect: /無法復原/ });
    await page.waitForFunction(() => document.querySelectorAll('.wb-rf-svn-entry').length === 1);
    await page.locator('[data-svn-tab="log"]').click();
    await page.locator('[data-svn-revision]').first().waitFor();
    await shot('svn');

    // Reopening keeps every update and the page on screen.
    await page.locator('.wb-rf-close').click();
    await openWorkspace(page);
    assert.equal(await page.locator('main.wb-rf-main').getAttribute('data-release-section'), 'svn');
    await card('tw').locator('.wb-rf-note-head').click();
    assert.equal(await current(), 'summary', 'the finished update is still there');
    await card('tap').locator('.wb-rf-note-head').click();
    assert.equal(await current(), 'brief');
    await context.close();
  }

  // One-click mode: rules set on the brief, then the whole update by itself.
  {
    const { context, page } = await openWorkbench();
    const { primary, card, confirm, assertFits, shot } = helpers(page);
    await openWorkspace(page);
    await page.locator('button[aria-controls="wb-rf-demo-menu"]').click();
    await page.locator('#wb-rf-demo-menu [role="radio"]').nth(1).click();
    await page.locator('#wb-rf-demo-menu label', { hasText: '第一次上傳熱更新中斷' }).locator('input').check();
    await page.keyboard.press('Escape');

    // 玩心 already has an update scheduled; open it from its card.
    await card('wanxin').locator('.wb-rf-note-head').click();
    const panel = page.locator('[data-release-autopilot-panel]');
    await panel.waitFor();
    await panel.locator('[data-release-rule="svnConflicts"] [role="radio"]', { hasText: '以雲端為準' }).click();
    await panel.locator('[role="radio"]', { hasText: '10 秒' }).click();
    await page.locator('.wb-rf-ready input').check();
    await assertFits('one-click brief');
    await shot('autopilot-brief');
    assert.equal(await primary.textContent().then((text) => text.trim()), '開始更新', 'the manual start stays the main action');
    await page.locator('[data-release-auto-start]').click();
    await confirm({ expect: /SVN 更新遇到衝突：以雲端為準/ });

    const bar = page.locator('[data-release-autopilot]');
    await bar.waitFor();
    assert.match(await card('wanxin').textContent(), /一鍵/);
    assert.equal(await primary.isDisabled(), true, 'nothing to click while it runs');
    await page.waitForFunction(() => /等待維護開始/.test(document.querySelector('[data-release-autopilot-detail]')?.textContent || ''), null, { timeout: 120_000 });
    assert.equal(await page.locator('[data-release-current]').getAttribute('data-release-current'), 'gmServer', 'the run shows the step it is on');
    await shot('autopilot-waiting');
    await bar.locator('button', { hasText: '快轉到維護時間' }).click();
    await page.waitForFunction(() => document.querySelector('[data-release-autopilot]')?.dataset.status === 'done', null, { timeout: 60_000 });
    assert.match(await card('wanxin').textContent(), /已完成/);
    await bar.locator('button', { hasText: '紀錄' }).click();
    const log = await bar.locator('.wb-rf-auto-log').textContent();
    assert.match(log, /自動處理 2 個 SVN 衝突/);
    assert.match(log, /上傳熱更新包：第 1 次重試/);
    await shot('autopilot-done');
    await context.close();
  }

  // English and dark at 1280 wide.
  {
    const { context, page } = await openWorkbench({ theme: 'dark', language: 'en', viewport: { width: 1280, height: 860 } });
    const { assertFits, newUpdate, shot } = helpers(page);
    await openWorkspace(page);
    assert.equal(await page.locator('.wb-rf-nav-item').first().textContent().then((text) => text.trim()), 'Overview');
    const text = await page.locator('.wb-rf-dialog').textContent();
    assert.doesNotMatch(text.replace(/抖音|玩心|红龙女王|闪耀羽月|不死无敌|圣独角兽|狂雷狮鹫|永夜魅影|星灵圣曦|大地镜影|雷霆镜影|炎魔镜影|无限大地|闪电灵主|风息灵主|烈焰灵主|纯水灵主|坐骑重生/g, ''), /[\u4e00-\u9fff]/, 'English copy has no Chinese outside data');
    await assertFits('english overview');
    await shot('dark-en-home');
    await newUpdate('tw');
    await page.locator('[data-release-create]').click();
    await assertFits('english brief');
    for (const section of ['plans', 'build', 'svn', 'history', 'platforms']) {
      await page.locator(`.wb-rf-nav [data-release-section="${section}"]`).click();
      await page.waitForTimeout(200);
      await assertFits(`english ${section}`);
    }
    await shot('dark-en-platforms');
    await context.close();
  }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('release workspace browser regression passed');
} finally {
  await browser.close();
}
