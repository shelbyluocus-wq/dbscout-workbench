import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.DBSCOUT_MORE_TEST_URL || 'http://127.0.0.1:1431';
const screenshots = 'output/playwright';
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.DBSCOUT_BROWSER_CHANNEL ? { channel: process.env.DBSCOUT_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(15_000);
await page.addInitScript(() => {
  localStorage.setItem('dbscout_language', 'zh-CN');
  localStorage.setItem('dbscout_theme', 'dark');
});
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const search = page.locator('.wb-dbhome-search input');
  await search.waitFor();
  const more = page.locator('[data-wb-rail-id="more"]');
  const menu = page.locator('#wb-activity-more-menu');
  const rows = page.locator('.wb-dbhome-object-row');
  await rows.first().waitFor();
  await rows.first().click();
  await rows.nth(1).click({ modifiers: ['Control'] });
  const selected = await page.locator('.wb-dbhome-object-row.is-selected').evaluateAll((elements) => elements.map((row) => row.dataset.tableName));
  assert.equal(selected.length, 2);
  await more.click();
  assert.deepEqual((await menu.getByRole('menuitem').allTextContents()).map((text) => text.trim()), ['覆盖同步…', '发送到…', '批量导入', '批量导出', '关联复核'].map((s) => s));
  const triggerBounds = await more.boundingBox();
  const menuBounds = await menu.boundingBox();
  assert.ok(menuBounds.x >= triggerBounds.x + triggerBounds.width, 'menu opens on the right');
  assert.equal(await menu.getAttribute('data-theme'), 'dark');
  await menu.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); });
  await page.screenshot({ path: `${screenshots}/workbench-more-dark.png` });
  await page.keyboard.press('Escape');
  assert.equal(await menu.count(), 0);
  assert.equal(await more.evaluate((el) => el === document.activeElement), true);
  await more.press('Enter');
  await menu.getByRole('menuitem', { name: '发送到…', exact: true }).click();
  const copyDialog = page.locator('.wb-table-copy-dialog');
  await copyDialog.waitFor();
  await copyDialog.locator('.wb-table-copy-row').first().waitFor();
  assert.deepEqual((await copyDialog.locator('.wb-table-copy-row input:checked').evaluateAll((inputs) => inputs.map((input) => input.value))).sort(), selected.sort());
  await copyDialog.locator('.wb-dialog-close').click();
  for (const [name, selector] of [
    ['覆盖同步…', '.wb-database-sync-dialog'],
    ['批量导入', '.wb-batch-import-dialog'],
    ['批量导出', '.wb-batch-transfer-dialog'],
    ['关联复核', '.wb-relations-dialog'],
  ]) {
    await more.click();
    await menu.getByRole('menuitem', { name, exact: true }).click();
    const dialog = page.locator(selector);
    await dialog.waitFor();
    if (name === '批量导出') {
      assert.equal(await dialog.locator('.wb-batch-transfer-row input:checked').count(), 2);
      const input = dialog.locator('.wb-batch-transfer-toolbar input[type="text"]');
      await input.fill('hero');
      await input.selectText();
      await input.click({ button: 'right' });
      await page.locator('.wb-input-context-menu').getByRole('menuitem', { name: /^复制/ }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'hero');
    }
    await dialog.locator('.wb-dialog-close').click();
  }
  await search.fill('hero');
  await search.evaluate((input) => { input.focus(); input.setSelectionRange(1, 3); });
  await search.click({ button: 'right', position: { x: 40, y: 12 } });
  const inputMenu = page.locator('.wb-input-context-menu');
  assert.equal(await inputMenu.getByRole('menuitem').count(), 2, 'input menus contain only copy and paste');
  await inputMenu.getByRole('menuitem', { name: /^复制/ }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'er');
  await page.evaluate(() => navigator.clipboard.writeText('ER'));
  await search.click({ button: 'right', position: { x: 40, y: 12 } });
  await inputMenu.getByRole('menuitem', { name: /^粘贴/ }).click();
  assert.equal(await search.inputValue(), 'hERo');
  await search.press('Control+z');
  assert.equal(await search.inputValue(), 'hero', 'menu paste participates in native undo');
  await page.evaluate(() => navigator.clipboard.writeText('skill'));
  await search.selectText();
  await search.click({ button: 'right', position: { x: 40, y: 12 } });
  await inputMenu.getByRole('menuitem', { name: /^粘贴/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.wb-dbhome-object-row')].every((row) => row.dataset.tableName.includes('skill')));
  assert.ok(await rows.count() > 0, 'paste updates the Vue search filter');
  await search.selectText();
  await search.evaluate((input) => { input.readOnly = true; });
  await search.click({ button: 'right', position: { x: 40, y: 12 } });
  assert.equal(await inputMenu.getByRole('menuitem', { name: /^复制/ }).isEnabled(), true);
  assert.equal(await inputMenu.getByRole('menuitem', { name: /^粘贴/ }).isDisabled(), true);
  await page.screenshot({ path: `${screenshots}/workbench-input-menu-dark.png` });
  await page.keyboard.press('Escape');
  assert.equal(await inputMenu.count(), 0);
  await search.evaluate((input) => { input.readOnly = false; });
  await page.locator('[data-wb-rail-id="settings"]').click();
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await page.locator('[data-wb-rail-id="settings"]').click();
  assert.equal(await page.locator('.mysql-workbench').getAttribute('data-theme'), 'light');
  await more.click();
  assert.equal(await menu.getAttribute('data-theme'), 'light');
  await menu.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); });
  await page.screenshot({ path: `${screenshots}/workbench-more-light.png` });
  await search.click();
  assert.equal(await menu.count(), 0, 'outside click closes More');
  for (const type of ['number', 'email']) {
    const cancelled = await search.evaluate((input, type) => {
      input.type = type;
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    }, type);
    assert.equal(cancelled, false, `${type} preserves the browser's native selection menu`);
    assert.equal(await inputMenu.count(), 0);
  }
  await search.evaluate((input) => { input.type = 'search'; });
  assert.deepEqual(errors, []);
  console.log('PASS: five More actions, right-side placement, keyboard/outside dismissal, selected tables, modal input copy, selection copy/paste, native undo, reactive search and read-only paste.');
} finally {
  await browser.close();
}
