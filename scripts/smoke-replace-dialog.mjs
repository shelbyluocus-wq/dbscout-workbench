// 冒烟验证：Ctrl+H 查找替换（mock 模式）。
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

try {
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 从数据库主页双击打开 player 表
  await page.locator('.wb-dbhome-object-row[data-table-name="player"] .wb-dbhome-object-name-button').dblclick();
  await page.waitForTimeout(800);

  // Ctrl+H 打开替换对话框
  await page.keyboard.press('Control+h');
  const dialog = page.locator('.wb-replace-dialog');
  await dialog.waitFor({ timeout: 3000 });
  console.log('dialog opened');

  // 范围提示应为整张表
  const scope = await dialog.locator('.wb-replace-scope').innerText();
  console.log('scope banner:', scope.trim());
  if (!scope.includes('整张表')) fail(`scope should be whole-table, got: ${scope}`);

  // 取一个单元格的原文本用于构造替换
  const cell = page.locator('.wb-grid td[data-column-name]').nth(1);
  const original = (await cell.innerText()).trim();
  console.log('original cell text:', JSON.stringify(original));
  if (!original) fail('could not read a cell value');

  const needle = original.slice(0, Math.min(2, original.length));
  await dialog.locator('input').first().fill(needle);
  await dialog.locator('input').nth(1).fill('烟测');
  await dialog.locator('button', { hasText: '全部替换' }).click();
  await page.waitForTimeout(600);

  // dryRun 确认框
  const confirmVisible = await page.locator('text=将在整张表中把').count();
  console.log('confirm shown:', confirmVisible > 0);
  if (confirmVisible) {
    await page.locator('.wb-confirm-dialog button', { hasText: '全部替换' }).click();
    await page.waitForTimeout(800);
  }
  const feedback = await dialog.locator('.wb-replace-feedback').innerText().catch(() => '');
  console.log('feedback:', feedback.trim());
  if (!feedback.includes('已替换')) fail(`expected success feedback, got: ${feedback}`);

  // 关闭对话框，验证网格里出现替换后的值
  await dialog.locator('.wb-dialog-close').click();
  await page.waitForTimeout(800);
  const afterText = await page.locator('.wb-grid').innerText();
  if (!afterText.includes('烟测')) fail('grid does not contain replaced value');
  else console.log('grid shows replaced value');

  // 多选范围提示：选两个单元格再开对话框
  const cellA = page.locator('.wb-grid td[data-column-name]').nth(1);
  await cellA.click();
  await page.keyboard.down('Shift');
  await page.locator('.wb-grid td[data-column-name]').nth(2).click();
  await page.keyboard.up('Shift');
  await page.keyboard.press('Control+h');
  await dialog.waitFor({ timeout: 3000 });
  const scope2 = await dialog.locator('.wb-replace-scope').innerText();
  console.log('selection scope banner:', scope2.trim());
  if (!scope2.includes('选区')) fail(`scope should be selection, got: ${scope2}`);
  const navDisabled = await dialog.locator('button', { hasText: '查找下一个' }).isDisabled();
  console.log('find-next disabled in selection scope:', navDisabled);
  if (!navDisabled) fail('find-next should be disabled in selection scope');

  await page.screenshot({ path: 'output/replace-dialog-smoke.png' });
} finally {
  await browser.close();
}
console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE OK');
