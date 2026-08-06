// 冒烟：单表导入向导「对比变化」分屏 diff 视图（mock 模式）。
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';

const BASE = `http://127.0.0.1:${process.env.SMOKE_PORT || 1431}/`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

function buildImportBuffer() {
  const workbook = XLSX.utils.book_new();
  const header = ['id', 'name', 'rarity', 'element', 'hp_base', 'atk_base', 'def_base', 'spd_base', 'skill_id', 'is_available'];
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      header,
      ['1', '向导冒烟改名', '5', '火', '1000', '100', '50', '110', '1001', '1'],
      ['999998', '向导冒烟新增', '4', '水', '900', '90', '40', '105', '1002', '1'],
    ]),
    'hero',
  );
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

async function openHeroTab() {
  // 默认启动就有首页；等待任意行渲染出来后再定位 hero
  const anyRow = page.locator('.wb-dbhome-object-row').first();
  try {
    await anyRow.waitFor({ timeout: 8000 });
  } catch {
    // 首页标签存在但未激活（例如刷新后停留在数据页）：直接点回首页
    const homeTab = page.locator('.wb-tab', { hasText: '首页' }).first();
    if (await homeTab.isVisible().catch(() => false)) {
      await homeTab.click();
      await page.waitForTimeout(800);
    } else {
      // 没有首页时，先确保侧栏展开，再双击数据库打开首页
      const dbItem = page.locator('.wb-tree-row.wb-database-item').first();
      if (!(await dbItem.isVisible().catch(() => false))) {
        await page.locator('.wb-titlebar-sidebar .wb-topbar-collapse-btn').click();
        await page.waitForTimeout(800);
      }
      await page.locator('.wb-tree-row.wb-database-item').first().dblclick();
      await page.waitForTimeout(900);
    }
  }
  const heroRow = page.locator('.wb-dbhome-object-row[data-table-name="hero"]').first();
  await heroRow.scrollIntoViewIfNeeded();
  await heroRow.locator('.wb-dbhome-object-name-button').dblclick();
  await page.waitForTimeout(1200);
}

async function runWizardComparison() {
  // 工具栏「导入」打开向导
  await page.locator('button', { hasText: '导入' }).first().click();
  const dialog = page.locator('.wb-import-wizard');
  await dialog.waitFor({ timeout: 5000 });

  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'wizard-smoke.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: buildImportBuffer(),
  });
  await page.waitForTimeout(1200);

  // Step 2（预览）→ Step 3（映射）→ Step 4（确认）
  await dialog.locator('button', { hasText: '下一步' }).click();
  await page.waitForTimeout(400);
  const nextBtn = dialog.locator('button', { hasText: '下一步' });
  if (await nextBtn.isDisabled()) fail('mapping step next button disabled (no columns matched)');
  await nextBtn.click();
  await page.waitForTimeout(400);

  // Step 4：点「对比变化」
  await dialog.locator('button', { hasText: '对比变化' }).click();
  const grid = dialog.locator('.wb-batch-diff').first();
  await grid.locator('.wb-batch-diff-body').waitFor({ timeout: 15000 });

  const dialogClass = await dialog.getAttribute('class');
  if (!dialogClass.includes('is-comparison-mode')) fail(`wizard dialog not enlarged: ${dialogClass}`);

  const groupHeaders = await grid.locator('.wb-batch-diff-caption').allInnerTexts();
  console.log('group headers:', JSON.stringify(groupHeaders));
  if (!groupHeaders.some((t) => t.includes('Excel 导入数据'))) fail('missing Excel group header');
  if (!groupHeaders.some((t) => t.includes('数据库当前数据'))) fail('missing DB group header');

  // 修改行两侧着色
  await dialog.locator('.wb-batch-comparison-filters button', { hasText: '修改' }).click();
  await page.waitForTimeout(400);
  const updated = await grid.locator('.wb-batch-diff-pane.is-after .wb-batch-diff-row.is-updated').count();
  const changedAfter = await grid.locator('.wb-batch-diff-cell.is-after.is-changed').count();
  const changedBefore = await grid.locator('.wb-batch-diff-cell.is-before.is-changed').count();
  console.log('updated/changedAfter/changedBefore:', updated, changedAfter, changedBefore);
  if (updated < 1) fail('expected an updated row in wizard comparison');
  if (changedAfter < 1 || changedBefore < 1) fail('expected tinted changed cells on both sides');

  // 新增行 + 删除行
  await dialog.locator('.wb-batch-comparison-filters button', { hasText: '新增' }).click();
  await page.waitForTimeout(300);
  if ((await grid.locator('.wb-batch-diff-pane.is-after .wb-batch-diff-row.is-inserted').count()) < 1) {
    fail('expected an inserted row in wizard comparison');
  }
  await dialog.locator('.wb-batch-comparison-filters button', { hasText: '删除' }).click();
  await page.waitForTimeout(300);
  if ((await grid.locator('.wb-batch-diff-pane.is-before .wb-batch-diff-row.is-deleted').count()) < 1) {
    fail('expected deleted rows in wizard comparison');
  }

  // 主按钮按对比结果命名
  const executeLabel = await dialog.locator('.wb-import-start-btn').innerText();
  console.log('execute label:', executeLabel);
  if (!executeLabel.includes('同步')) fail(`unexpected execute label: ${executeLabel}`);
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await openHeroTab();
  await runWizardComparison();
  await page.screenshot({ path: 'output/smoke-wizard-comparison-light.png' });
  console.log('light wizard comparison screenshot saved');

  await page.evaluate(() => localStorage.setItem('dbscout_theme', 'dark'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await openHeroTab();
  await runWizardComparison();
  await page.screenshot({ path: 'output/smoke-wizard-comparison-dark.png' });
  console.log('dark wizard comparison screenshot saved');
} finally {
  await browser.close();
}
console.log(process.exitCode ? 'SMOKE WIZARD FAILED' : 'SMOKE WIZARD OK');
