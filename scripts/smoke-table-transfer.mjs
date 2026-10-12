// 冒烟：一键转表对话框（mock 模式）。验证左侧功能栏入口按钮、模板页签、
// 模拟转表流程的状态与日志渲染。
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

// 预置一个已配置完整的决胜1模板，打开对话框后需再点「开始转表」。
// The saved user template has complete paths, so it proves custom templates
// load and run. Seed once per tab: the reload check must see what was saved.
const SEEDED_CUSTOM = {
  id: 'custom-smoke-seeded',
  name: '测试服',
  scriptPath: 'E:\\tools\\测试服\\生成全部配置.bat',
  projectRoot: 'E:\\client\\test',
  conflictStrategy: 'manual',
};
await page.addInitScript((custom) => {
  if (sessionStorage.getItem('smoke-table-transfer-seeded')) return;
  sessionStorage.setItem('smoke-table-transfer-seeded', '1');
  localStorage.setItem(
    'dbscout_table_transfer_templates',
    JSON.stringify([
      { id: 'juesheng-1', scriptPath: 'D:\\Versions\\tools\\生成配置\\1-生成全部配置-客户端\\1.生成全部配置.bat', projectRoot: 'D:\\Versions\\nzg', conflictStrategy: 'theirs' },
      { id: 'juesheng-2', scriptPath: '', projectRoot: 'D:\\client\\jswz', conflictStrategy: 'mine' },
      custom,
    ]),
  );
}, SEEDED_CUSTOM);

await page.goto('http://127.0.0.1:1431', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);

// The entry lives in the always-visible activity rail, so it must stay usable
// whichever state the database sidebar starts in and after toggling it.
const entry = page.locator('.wb-activity-rail button[aria-label="一键转表"]');
if (!(await entry.count())) fail('activity rail has no table transfer entry');
for (const state of ['initial sidebar state', 'toggled sidebar state']) {
  if (state !== 'initial sidebar state') {
    await page.locator('#wb-topbar-sidebar-actions .wb-topbar-collapse-btn').click();
    await page.waitForTimeout(800);
  }
  if (!(await entry.isVisible().catch(() => false))) fail(`table transfer entry hidden in the ${state}`);
  const outsideRail = await page.evaluate(() => {
    const btn = document.querySelector('.wb-activity-rail button[aria-label="一键转表"]');
    const rail = btn?.closest('.wb-activity-rail');
    if (!btn || !rail) return null;
    const b = btn.getBoundingClientRect();
    const r = rail.getBoundingClientRect();
    return b.left < r.left - 0.5 || b.right > r.right + 0.5 || b.bottom > r.bottom + 0.5;
  });
  if (outsideRail !== false) fail(`table transfer entry escapes the activity rail in the ${state}`);
}
await entry.click();

const dialog = page.locator('.wb-table-transfer-dialog');
await dialog.waitFor({ timeout: 4000 });

await page.waitForTimeout(400);
if (await dialog.locator('.wb-table-transfer-status-line').count()) {
  const opened = await dialog.locator('.wb-table-transfer-status-line').innerText();
  if (/转表进行中|转表完成/.test(opened)) {
    fail(`opening the dialog should not auto-run, got: ${opened}`);
  }
}
await dialog.locator('.wb-dialog-primary').click();
await page.waitForTimeout(500);
const statusLine = await dialog.locator('.wb-table-transfer-status-line').innerText();
console.log('status line:', statusLine.trim().replace(/\s+/g, ' '));
if (!statusLine.includes('转表完成')) fail(`expected success state after 开始转表, got: ${statusLine}`);

const log = await dialog.locator('.wb-table-transfer-log').innerText();
if (!log.includes('[mock]')) fail(`expected mock log lines, got: ${log.slice(0, 120)}`);
console.log('log lines:', log.split('\n').length);

// 切到决胜2页签：显示预置工程路径 + 本地为准单选
await dialog.locator('.wb-table-transfer-tab', { hasText: '决胜2' }).click();
await page.waitForTimeout(200);
const projectInput = await dialog.locator('.wb-table-transfer-path input').nth(1).inputValue();
if (projectInput !== 'D:\\client\\jswz') fail(`决胜2 project root wrong: ${projectInput}`);
const checked = await dialog.locator('.wb-table-transfer-strategy label:has(input:checked)').innerText();
if (!checked.includes('本地')) fail(`决胜2 strategy should be mine, got: ${checked}`);
if ((await dialog.locator('.wb-table-transfer-browse').count()) !== 2) {
  fail('expected 浏览 buttons next to script and project pickers');
}
if (!(await dialog.locator('.wb-table-transfer-strategy label', { hasText: '遇到冲突由我处理' }).count())) {
  fail('missing 遇到冲突由我处理 option');
}
if (await dialog.locator('.wb-table-transfer-browse').nth(1).isDisabled()) {
  fail('configured project path should enable 浏览');
}
await dialog.locator('.wb-table-transfer-tab', { hasText: '决胜1' }).click();
await page.waitForTimeout(150);
if (await dialog.locator('.wb-table-transfer-browse').nth(0).isDisabled()) {
  fail('configured script path should enable 浏览');
}
if (await dialog.locator('.wb-table-transfer-hint').count()) {
  fail('footer hint should be removed');
}
const mineLabel = dialog.locator('.wb-table-transfer-strategy label', { hasText: '冲突以本地为准' });
if ((await mineLabel.locator('svg').count()) < 1) {
  fail('冲突以本地为准 should have an icon');
}
const theirsRadio = dialog.locator('.wb-table-transfer-strategy input[type="radio"]').first();
await theirsRadio.click();
const radioOutline = await theirsRadio.evaluate((el) => getComputedStyle(el).outlineStyle);
if (radioOutline && radioOutline !== 'none') fail(`radio focus should not draw a box, got outline: ${radioOutline}`);
const logFont = await dialog.locator('.wb-table-transfer-log').evaluate((el) => getComputedStyle(el).fontFamily);
const uiFont = await dialog.evaluate((el) => getComputedStyle(el).fontFamily);
if (logFont !== uiFont) fail(`log font should match dialog font. log=${logFont} ui=${uiFont}`);

await page.screenshot({ path: 'output/smoke-table-transfer.png' });
console.log('screenshot: output/smoke-table-transfer.png');

// User templates: named inline (Enter saves, Esc cancels, leaving the field
// drops an unusable name), renamed by double-click, F2 or the Rename button,
// kept across a reload and deleted after a confirmation. Built-ins stay fixed.
const tabNames = async () =>
  (await dialog.locator('.wb-table-transfer-tab').allInnerTexts()).map((text) => text.trim());
const activeTabName = async () =>
  (await dialog.locator('.wb-table-transfer-tab.is-active').innerText()).trim();
const pathValues = () =>
  dialog.locator('.wb-table-transfer-path input').evaluateAll((inputs) => inputs.map((input) => input.value));
const nameInput = dialog.locator('.wb-table-transfer-name-input');
const nameError = dialog.locator('#wb-table-transfer-name-error');
const templateActions = dialog.locator('.wb-table-transfer-template-actions');
const expectNameFieldAlone = async (when) => {
  if ((await templateActions.count()) || (await dialog.locator('.wb-table-transfer-add').count())) {
    fail(`only the name field should be offered while ${when}`);
  }
};

if (await templateActions.count()) fail('built-in templates should not offer rename or delete');
await dialog.locator('.wb-table-transfer-tab', { hasText: '决胜1' }).dblclick();
if (await nameInput.count()) fail('double-clicking a built-in template should not rename it');

await dialog.locator('.wb-table-transfer-tab', { hasText: SEEDED_CUSTOM.name }).click();
await page.waitForTimeout(150);
const seededPaths = await pathValues();
if (seededPaths[0] !== SEEDED_CUSTOM.scriptPath || seededPaths[1] !== SEEDED_CUSTOM.projectRoot) {
  fail(`saved custom template paths wrong: ${seededPaths.join(' | ')}`);
}
const seededStrategy = await dialog.locator('.wb-table-transfer-strategy label:has(input:checked)').innerText();
if (!seededStrategy.includes('由我处理')) fail(`saved custom template should resolve conflicts manually, got: ${seededStrategy}`);
if ((await templateActions.locator('button').count()) !== 2) fail('custom templates should offer rename and delete');
await dialog.locator('.wb-dialog-primary').click();
await page.waitForTimeout(500);
const customRun = await dialog.locator('.wb-table-transfer-status-line').innerText();
if (!customRun.includes('转表完成')) fail(`a saved custom template should run, got: ${customRun}`);

await dialog.locator('.wb-table-transfer-add').click();
await nameInput.waitFor({ timeout: 2000 });
const suggestion = await nameInput.evaluate((input) => ({
  value: input.value,
  focused: document.activeElement === input,
  selected: input.selectionStart === 0 && input.selectionEnd === input.value.length,
}));
if (suggestion.value !== '新模板') fail(`a new template should suggest 新模板, got: ${suggestion.value}`);
if (!suggestion.focused || !suggestion.selected) fail('the suggested name should be focused and selected');
await expectNameFieldAlone('a new template is being named');
for (const [draft, expected] of [['   ', '请输入'], ['决胜1', '同名']]) {
  await nameInput.fill(draft);
  await nameInput.press('Enter');
  await page.waitForTimeout(100);
  if (!(await nameInput.isVisible())) fail(`Enter on "${draft}" should keep the name field open`);
  const message = await nameError.innerText().catch(() => '');
  if (!message.includes(expected)) fail(`"${draft}" should report ${expected}, got: ${message}`);
}
await page.screenshot({ path: 'output/smoke-table-transfer-name-error.png' });
console.log('screenshot: output/smoke-table-transfer-name-error.png');
await dialog.locator('.wb-table-transfer-header h2').click();
await page.waitForTimeout(150);
if (await nameInput.count()) fail('leaving the name field should close it');
if ((await tabNames()).length !== 3) fail('leaving the field with an unusable name should not add a template');

await dialog.locator('.wb-table-transfer-add').click();
await nameInput.waitFor({ timeout: 2000 });
await nameInput.fill('决胜3');
await nameInput.press('Enter');
await page.waitForTimeout(150);
if (await nameInput.count()) fail('Enter on a valid name should close the name field');
if ((await activeTabName()) !== '决胜3') fail(`the new template should become active, got: ${await activeTabName()}`);
if ((await pathValues()).some(Boolean)) fail('a new template should start without paths');
if (!(await dialog.locator('.wb-dialog-primary').isDisabled())) fail('start should wait until the new template has paths');
const focusedAfterAdd = await page.evaluate(() => document.activeElement?.textContent?.trim() || '');
if (focusedAfterAdd !== '决胜3') fail(`focus should return to the new tab, got: ${focusedAfterAdd}`);

await dialog.locator('.wb-table-transfer-tab.is-active').dblclick();
await nameInput.waitFor({ timeout: 2000 });
await expectNameFieldAlone('a template is being renamed');
await nameInput.fill('不会保存');
await nameInput.press('Escape');
await page.waitForTimeout(150);
if (!(await dialog.isVisible())) fail('Esc in the name field should cancel the rename, not close the dialog');
if ((await activeTabName()) !== '决胜3') fail('Esc should keep the old name');
await page.keyboard.press('F2');
await nameInput.waitFor({ timeout: 2000 });
await nameInput.fill('决胜3 外网');
await nameInput.press('Enter');
await page.waitForTimeout(150);
if ((await activeTabName()) !== '决胜3 外网') fail(`F2 rename failed, got: ${await activeTabName()}`);
await templateActions.locator('button', { hasText: '重命名' }).click();
await nameInput.waitFor({ timeout: 2000 });
if ((await nameInput.inputValue()) !== '决胜3 外网') fail('the Rename button should start from the current name');
await nameInput.press('Enter');
await page.waitForTimeout(150);
if (await nameInput.count()) fail('Enter on the unchanged name should close the field');

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
await entry.click();
await dialog.waitFor({ timeout: 4000 });
await page.waitForTimeout(300);
const reloadedTabs = (await tabNames()).join(' | ');
if (reloadedTabs !== `决胜1 | 决胜2 | ${SEEDED_CUSTOM.name} | 决胜3 外网`) fail(`templates after reload: ${reloadedTabs}`);
if ((await activeTabName()) !== '决胜3 外网') fail('the selected custom template should survive a reload');
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('dbscout_table_transfer_templates') || '[]'));
if (stored.some((template) => 'builtIn' in template)) fail('builtIn is derived and should not be saved');
await page.screenshot({ path: 'output/smoke-table-transfer-custom.png' });
console.log('screenshot: output/smoke-table-transfer-custom.png');

await templateActions.locator('.is-danger').click();
const confirmDialog = page.locator('.wb-confirm-dialog');
await confirmDialog.waitFor({ timeout: 2000 });
if (!(await confirmDialog.innerText()).includes('决胜3 外网')) fail('the delete confirmation should name the template');
await confirmDialog.locator('.wb-dialog-primary').click();
await page.waitForTimeout(200);
const remainingTabs = (await tabNames()).join(' | ');
if (remainingTabs !== `决胜1 | 决胜2 | ${SEEDED_CUSTOM.name}`) fail(`templates after delete: ${remainingTabs}`);
if ((await activeTabName()) !== SEEDED_CUSTOM.name) fail('deleting the last template should select its left neighbour');
if (!(await dialog.isVisible())) fail('confirming the delete should keep the transfer dialog open');

await browser.close();
console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE OK');
