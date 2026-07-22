// 冒烟验证 2：整表范围下「查找下一个」+「替换」单步流程（mock 模式）。
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

try {
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.locator('.wb-dbhome-object-row[data-table-name="player"] .wb-dbhome-object-name-button').dblclick();
  await page.waitForTimeout(800);

  await page.keyboard.press('Control+h');
  const dialog = page.locator('.wb-replace-dialog');
  await dialog.waitFor({ timeout: 3000 });

  await dialog.locator('input').first().fill('user_0003');
  await dialog.locator('input').nth(1).fill('单步替换');

  // 第一次点「替换」= 查找并选中第一个命中
  await dialog.locator('button', { hasText: /^替换$/ }).click();
  await page.waitForTimeout(600);
  const hit = await page.locator('.wb-search-hit-count').innerText().catch(() => '');
  console.log('hit summary after find:', hit.trim());

  // 第二次点「替换」= 替换当前命中并跳到下一个
  await dialog.locator('button', { hasText: /^替换$/ }).click();
  await page.waitForTimeout(800);

  const gridText = await page.locator('.wb-grid').innerText();
  if (gridText.includes('单步替换')) console.log('single replace applied');
  else fail('single replace did not apply');
  if (gridText.includes('user_0003')) fail('old value still present');
} finally {
  await browser.close();
}
console.log(process.exitCode ? 'SMOKE2 FAILED' : 'SMOKE2 OK');
