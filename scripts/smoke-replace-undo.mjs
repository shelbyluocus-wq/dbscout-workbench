// 冒烟验证 3：整表替换 → Ctrl+Z 撤销（带进度）→ Ctrl+Y 重做（mock 模式）。
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

try {
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.locator('.wb-dbhome-object-row[data-table-name="player"] .wb-dbhome-object-name-button').dblclick();
  await page.waitForTimeout(800);

  const firstUsername = () => page.locator('.wb-grid td[data-column-name="username"]').first().innerText();
  const before = (await firstUsername()).trim();
  console.log('before:', before);

  // 整表替换
  await page.keyboard.press('Control+h');
  const dialog = page.locator('.wb-replace-dialog');
  await dialog.waitFor({ timeout: 3000 });
  await dialog.locator('input').first().fill('user');
  await dialog.locator('input').nth(1).fill('撤回测试');
  await dialog.locator('button.wb-replace-all-button').click();
  await page.locator('.wb-confirm-dialog button', { hasText: '全部替换' }).click();
  await page.waitForTimeout(1000);
  const feedback = await dialog.locator('.wb-replace-feedback').innerText();
  console.log('feedback:', feedback.trim());
  if (!feedback.includes('Ctrl+Z')) fail('feedback should mention Ctrl+Z');
  await dialog.locator('.wb-dialog-close').click();
  await page.waitForTimeout(800);

  const afterReplace = (await firstUsername()).trim();
  console.log('after replace:', afterReplace);
  if (!afterReplace.includes('撤回测试')) fail('replace did not apply');

  // Ctrl+Z 撤销（焦点在网格容器上，避免落在输入框里触发原生撤销）
  await page.locator('.wb-grid').first().click();
  await page.keyboard.press('Control+z');
  // 进度条可能出现得很短暂，轮询捕捉
  let progressSeen = false;
  for (let i = 0; i < 40; i += 1) {
    if (await page.locator('.wb-history-progress').count()) { progressSeen = true; break; }
    await page.waitForTimeout(25);
  }
  console.log('progress overlay seen:', progressSeen);
  await page.waitForTimeout(1200);
  const afterUndo = (await firstUsername()).trim();
  console.log('after undo:', afterUndo);
  if (afterUndo !== before) fail(`undo should restore "${before}", got "${afterUndo}"`);
  const status1 = await page.locator('.wb-status-bar, [class*="status"]').first().innerText().catch(() => '');
  console.log('status after undo:', status1.trim().slice(0, 80));

  // Ctrl+Y 重做
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(1200);
  const afterRedo = (await firstUsername()).trim();
  console.log('after redo:', afterRedo);
  if (!afterRedo.includes('撤回测试')) fail('redo should re-apply replacement');

  await page.screenshot({ path: 'output/replace-undo-smoke.png' });
} finally {
  await browser.close();
}
console.log(process.exitCode ? 'SMOKE3 FAILED' : 'SMOKE3 OK');
