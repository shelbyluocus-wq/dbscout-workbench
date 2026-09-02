// 冒烟：一键转表对话框（mock 模式）。验证工具栏入口按钮、模板页签、
// 模拟转表流程的状态与日志渲染。
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

// 预置一个已配置完整的决胜1模板，打开对话框后需再点「开始转表」。
await page.addInitScript(() => {
  localStorage.setItem(
    'dbscout_table_transfer_templates',
    JSON.stringify([
      { id: 'juesheng-1', scriptPath: 'D:\\Versions\\tools\\生成配置\\1-生成全部配置-客户端\\1.生成全部配置.bat', projectRoot: 'D:\\Versions\\nzg', conflictStrategy: 'theirs' },
      { id: 'juesheng-2', scriptPath: '', projectRoot: 'D:\\client\\jswz', conflictStrategy: 'mine' },
    ]),
  );
});

await page.goto('http://127.0.0.1:1431', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);

// 侧栏可能默认折叠，折叠时顶栏动作区不可见；先展开（同其它 smoke 脚本的 ensureSidebar）。
const entry = page.locator('button[aria-label="一键转表"]');
if (!(await entry.count())) fail('顶栏没有找到一键转表按钮');
if (!(await entry.isVisible().catch(() => false))) {
  await page.locator('.wb-topbar-collapse-btn').first().click();
  await page.waitForTimeout(800);
}
if (!(await entry.isVisible().catch(() => false))) fail('一键转表按钮在展开侧栏后仍不可见');
// 回归：.wb-sidebar-actions 的 max-width 曾只容 3 个按钮（70px），第 4 个被
// overflow:hidden 裁掉但 DOM 可见性检测不出来；这里断言按钮没超出容器右缘。
const clipBoxes = await page.evaluate(() => {
  const btn = document.querySelector('button[aria-label="一键转表"]');
  const wrap = btn?.closest('.wb-sidebar-actions');
  if (!btn || !wrap) return null;
  const b = btn.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  return { btnRight: b.right, wrapRight: w.right };
});
if (!clipBoxes) fail('找不到按钮或其 .wb-sidebar-actions 容器');
if (clipBoxes.btnRight > clipBoxes.wrapRight + 0.5) {
  fail(`按钮被容器裁剪: btnRight=${clipBoxes.btnRight} wrapRight=${clipBoxes.wrapRight}`);
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
await browser.close();
console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE OK');
