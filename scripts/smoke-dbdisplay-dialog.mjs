// 冒烟：数据库名称与标记对话框重设计截图（mock 模式，明暗双主题）。
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

async function openDialog() {
  let dbItem = page.locator('.wb-tree-row.wb-database-item').first();
  if (!(await dbItem.isVisible().catch(() => false))) {
    await page.locator('.wb-titlebar-sidebar .wb-topbar-collapse-btn').click();
    await page.waitForTimeout(800);
  }
  dbItem = page.locator('.wb-tree-row.wb-database-item').first();
  if (!(await dbItem.isVisible().catch(() => false))) {
    await page.locator('.wb-tree-row.wb-connection-node').first().click();
    await page.waitForTimeout(500);
  }
  await dbItem.scrollIntoViewIfNeeded();
  await dbItem.click({ button: 'right' });
  await page.waitForTimeout(350);
  await page.locator('.wb-context-menu button', { hasText: '名称与标记' }).click();
  const dialog = page.locator('.wb-database-display-dialog');
  await dialog.waitFor({ timeout: 4000 });
  return dialog;
}

async function decorate(dialog) {
  await page.locator('#wb-database-alias-input').fill('订单配置中心');
  await dialog.locator('.wb-database-icon-options button', { hasText: '云端' }).click();
  await dialog.locator('.wb-database-color-setting').first().locator('[aria-label="图标颜色使用#2563eb"]').click();
  await dialog.locator('[aria-label="名称颜色使用蔚蓝"]').click();
  await page.waitForTimeout(250);
  // 回归验证：悬停色板不得被全局 button hover 洗白
  const rose = dialog.locator('[aria-label="图标颜色使用#be123c"]');
  await rose.hover();
  await page.waitForTimeout(200);
  const hoverBg = await rose.evaluate((el) => getComputedStyle(el).backgroundColor);
  console.log('hovered swatch bg:', hoverBg);
  if (hoverBg !== 'rgb(190, 18, 60)') fail(`hover washed swatch to ${hoverBg}`);
}

try {
  // ── 亮色主题 ──
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  let dialog = await openDialog();
  await decorate(dialog);
  await page.screenshot({ path: 'output/redesign-dbdisplay-light.png' });
  console.log('light screenshot saved');

  // 结构完整性快速断言
  const swatchCount = await dialog.locator('.wb-database-color-setting').first().locator('.wb-database-color-swatch').count();
  console.log('icon color swatches (含跟随主题/自定义):', swatchCount);
  if (swatchCount !== 10) fail(`expected 10 swatches, got ${swatchCount}`);
  const previewChild = await dialog.locator('.wb-database-marker-row.is-child').innerText();
  if (!previewChild.includes('子表继承')) fail('preview child row missing');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ── 暗色主题 ──
  await page.evaluate(() => localStorage.setItem('dbscout_theme', 'dark'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  dialog = await openDialog();
  await decorate(dialog);
  await page.screenshot({ path: 'output/redesign-dbdisplay-dark.png' });
  console.log('dark screenshot saved');
} finally {
  await browser.close();
}
console.log(process.exitCode ? 'SMOKE DBDISPLAY FAILED' : 'SMOKE DBDISPLAY OK');
