// 冒烟验证 4：选区内查找下一个 + 命中数量显示 + 深色模式配色（mock 模式）。
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

try {
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.locator('.wb-dbhome-object-row[data-table-name="player"] .wb-dbhome-object-name-button').dblclick();
  await page.waitForTimeout(800);

  // 多选 username 列前三个单元格
  const colCells = page.locator('.wb-grid td[data-column-name="username"]');
  await colCells.nth(0).click();
  await page.keyboard.down('Shift');
  await colCells.nth(2).click();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);

  await page.keyboard.press('Control+h');
  const dialog = page.locator('.wb-replace-dialog');
  await dialog.waitFor({ timeout: 3000 });

  const scope = await dialog.locator('.wb-replace-scope').innerText();
  console.log('scope:', scope.trim());
  if (!scope.includes('选区内')) fail(`expected selection scope, got: ${scope}`);

  // 命中数量显示
  await dialog.locator('input').first().fill('user');
  await page.waitForTimeout(300);
  const matches = await dialog.locator('.wb-replace-matches').innerText();
  console.log('match summary:', matches.trim());
  if (!matches.includes('选区内命中 3 个单元格')) fail(`expected 3 matched cells, got: ${matches}`);

  // 查找下一个在选区范围应可用
  const findNextBtn = dialog.locator('button', { hasText: '查找下一个' });
  if (await findNextBtn.isDisabled()) fail('find-next should be enabled in selection scope');

  // 查找下一个：导航 + 位置显示
  await findNextBtn.click();
  await page.waitForTimeout(400);
  const nav1 = await dialog.locator('.wb-replace-matches').innerText();
  console.log('after find-next:', nav1.trim());
  if (!nav1.includes('第 1 / 3 个命中')) fail(`expected nav 1/3, got: ${nav1}`);
  await findNextBtn.click();
  await page.waitForTimeout(400);
  const nav2 = await dialog.locator('.wb-replace-matches').innerText();
  console.log('after find-next 2:', nav2.trim());
  if (!nav2.includes('第 2 / 3 个命中')) fail(`expected nav 2/3, got: ${nav2}`);

  // 替换当前（当前命中 = 第 2 个 = user_0002）
  await dialog.locator('input').nth(1).fill('选区替换');
  await dialog.locator('button', { hasText: /^替换$/ }).click();
  await page.waitForTimeout(800);
  const gridText = await page.locator('.wb-grid').innerText();
  if (gridText.includes('选区替换_0002')) console.log('selection replace-current applied');
  else fail('selection replace-current did not apply');
  if (gridText.includes('选区替换_0001')) fail('first cell should not be replaced yet');
  await dialog.locator('.wb-dialog-close').click();
  await page.waitForTimeout(400);

  // 深色模式配色截图
  const themeBtn = page.locator('button[title="切换主题"], button[aria-label="切换主题"]').first();
  if (await themeBtn.count()) {
    await themeBtn.click();
    await page.waitForTimeout(500);
  }
  await colCells.nth(0).click();
  await page.keyboard.down('Shift');
  await colCells.nth(2).click();
  await page.keyboard.up('Shift');
  await page.keyboard.press('Control+h');
  await dialog.waitFor({ timeout: 3000 });
  await dialog.locator('input').first().fill('user');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'output/replace-dialog-dark.png' });
  console.log('dark screenshot saved');
} finally {
  await browser.close();
}
console.log(process.exitCode ? 'SMOKE4 FAILED' : 'SMOKE4 OK');
