// 冒烟验证 5：查找/替换一体化弹窗（mock 模式）。
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

try {
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.locator('.wb-dbhome-object-row[data-table-name="player"] .wb-dbhome-object-name-button').dblclick();
  await page.waitForTimeout(800);

  // 1) Ctrl+F 弹出查找页
  await page.keyboard.press('Control+f');
  const dialog = page.locator('.wb-find-replace-dialog');
  await dialog.waitFor({ timeout: 3000 });
  const findTabActive = await dialog.locator('.wb-find-replace-tab.is-active').innerText();
  console.log('active tab after Ctrl+F:', findTabActive.trim());
  if (!findTabActive.includes('查找')) fail('Ctrl+F should open find tab');
  if (await dialog.locator('input').nth(1).isVisible().catch(() => false)) {
    // 查找页不应显示"替换为"
    const labels = await dialog.locator('.wb-replace-field > span').allInnerTexts();
    if (labels.some((t) => t.includes('替换为'))) fail('find tab should not show replacement input');
  }

  // 2) 默认紧凑态无列表；点击「查找全部」才展开结果列表
  await dialog.locator('input').first().fill('user_0003');
  await page.waitForTimeout(700);
  if (await dialog.locator('.wb-find-results').count()) fail('list should stay collapsed before clicking 查找全部');
  await dialog.locator('button', { hasText: '查找全部' }).click();
  await page.waitForTimeout(900);
  const rowCount = await dialog.locator('.wb-find-result-row').count();
  console.log('result rows:', rowCount);
  if (rowCount !== 1) fail(`expected 1 result row, got ${rowCount}`);
  const summary = await dialog.locator('.wb-find-results-summary').innerText();
  console.log('summary:', summary.trim());

  // 3) 点击列表行跳转单元格
  await dialog.locator('.wb-find-result-row').first().click();
  await page.waitForTimeout(500);
  const selectedCellText = await page.locator('.wb-grid td.is-selected, .wb-grid td[class*="selected"]').first().innerText().catch(() => '');
  console.log('selected cell:', selectedCellText.trim());
  if (!selectedCellText.includes('user_0003')) fail(`jump should select user_0003 cell, got: ${selectedCellText}`);

  // 4) Ctrl+H 切到替换页（弹窗已打开时切 tab）
  await page.keyboard.press('Control+h');
  await page.waitForTimeout(400);
  const replaceTabActive = await dialog.locator('.wb-find-replace-tab.is-active').innerText();
  console.log('active tab after Ctrl+H:', replaceTabActive.trim());
  if (!replaceTabActive.includes('替换')) fail('Ctrl+H should switch to replace tab');

  // 5) 替换当前（当前命中 = user_0003）
  await dialog.locator('input').nth(1).fill('列表替换');
  await dialog.locator('button', { hasText: /^替换$/ }).click();
  await page.waitForTimeout(800);
  // 整格命中被整段替换：user_0003 → 列表替换
  const replacedCell = (await page.locator('.wb-grid td[data-column-name="username"]').nth(2).innerText()).trim();
  console.log('row3 username after replace:', replacedCell);
  if (replacedCell === '列表替换') console.log('list replace-current applied');
  else fail(`list replace-current did not apply, got: ${replacedCell}`);

  // 6) 选区范围：多选后 Ctrl+F
  await dialog.locator('.wb-dialog-close').click();
  await page.waitForTimeout(400);
  const colCells = page.locator('.wb-grid td[data-column-name="username"]');
  await colCells.nth(0).click();
  await page.keyboard.down('Shift');
  await colCells.nth(2).click();
  await page.keyboard.up('Shift');
  await page.keyboard.press('Control+f');
  await dialog.waitFor({ timeout: 3000 });
  await dialog.locator('input').first().fill('user');
  await dialog.locator('button', { hasText: '查找全部' }).click();
  await page.waitForTimeout(600);
  const selSummary = await dialog.locator('.wb-find-results-summary').innerText();
  console.log('selection summary:', selSummary.trim());
  // user_0003 已被替换为「列表替换」，选区内 user 只剩 2 个命中
  if (!selSummary.includes('选区内命中 2 个单元格')) fail(`expected 2 selection matches, got: ${selSummary}`);
  // 选区导航保留选区
  await dialog.locator('button', { hasText: '下一个' }).click();
  await page.waitForTimeout(400);
  const scopeAfterNav = await dialog.locator('.wb-find-replace-scope-text').innerText();
  if (!scopeAfterNav.includes('选区内')) fail(`selection should survive navigation, got: ${scopeAfterNav}`);
  console.log('selection navigation preserves range');

  await page.screenshot({ path: 'output/find-replace-dialog-light.png' });

  // 7) 深色模式截图
  await page.evaluate(() => localStorage.setItem('dbscout_theme', 'dark'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // 工作区会恢复已打开的 player 页签；不在主页时无需再双击打开。
  const playerRow = page.locator('.wb-dbhome-object-row[data-table-name="player"] .wb-dbhome-object-name-button');
  if (await playerRow.count()) {
    await playerRow.dblclick();
    await page.waitForTimeout(800);
  }
  await page.keyboard.press('Control+f');
  await dialog.waitFor({ timeout: 3000 });
  await dialog.locator('input').first().fill('user');
  await dialog.locator('button', { hasText: '查找全部' }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'output/find-replace-dialog-dark.png' });
  console.log('dark screenshot saved');
} finally {
  await browser.close();
}
console.log(process.exitCode ? 'SMOKE5 FAILED' : 'SMOKE5 OK');
