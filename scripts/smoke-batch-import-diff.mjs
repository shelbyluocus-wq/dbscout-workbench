// 冒烟：首页 Ctrl+D 打开表设计（含多选）+ 批量导入「对比变化」双栏 diff 视图（mock 模式）。
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';

const BASE = `http://127.0.0.1:${process.env.SMOKE_PORT || 1431}/`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

function buildImportBuffer() {
  const workbook = XLSX.utils.book_new();
  // hero: id=1 改名字（修改），id=999999 新增；其余数据库现有行会成为“删除”。
  // mock 校验要求所有非空字段都有值，所以带齐 hero 的必填列。
  const header = ['id', 'name', 'rarity', 'element', 'hp_base', 'atk_base', 'def_base', 'spd_base', 'skill_id', 'is_available'];
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      header,
      ['1', '冒烟改名英雄', '5', '火', '1000', '100', '50', '110', '1001', '1'],
      ['999999', '冒烟新增英雄', '4', '水', '900', '90', '40', '105', '1002', '1'],
    ]),
    'hero',
  );
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

async function ensureHomePage() {
  const homeRow = page.locator('.wb-dbhome-object-row[data-table-name="hero"]').first();
  if (await homeRow.isVisible().catch(() => false)) return;
  // 没有首页时，从侧栏双击数据库打开首页
  const dbItem = page.locator('.wb-tree-row.wb-database-item').first();
  await dbItem.dblclick();
  await page.waitForTimeout(800);
}

async function smokeCtrlD() {
  // 单选：点击 hero 行的名称按钮选中它，再按 Ctrl+D
  const heroRow = page.locator('.wb-dbhome-object-row[data-table-name="hero"]').first();
  await heroRow.scrollIntoViewIfNeeded();
  await heroRow.locator('.wb-dbhome-object-name-button').click();
  await page.waitForTimeout(250);
  await page.keyboard.press('Control+d');
  await page.waitForTimeout(600);
  let designTabs = await page.locator('.wb-tab:has(.wb-tab-kind)').count();
  console.log('design tabs after single Ctrl+D:', designTabs);
  if (designTabs !== 1) fail(`expected 1 design tab after single Ctrl+D, got ${designTabs}`);

  // 多选：先切回首页标签，Ctrl+点击 item 行追加选中，再按 Ctrl+D
  await page.locator('.wb-tab:not(:has(.wb-tab-kind))').first().click();
  await page.waitForTimeout(400);
  const itemRow = page.locator('.wb-dbhome-object-row[data-table-name="item"]').first();
  await itemRow.scrollIntoViewIfNeeded();
  await itemRow.locator('.wb-dbhome-object-name-button').click({ modifiers: ['Control'] });
  await page.waitForTimeout(250);
  await page.keyboard.press('Control+d');
  await page.waitForTimeout(600);
  designTabs = await page.locator('.wb-tab:has(.wb-tab-kind)').count();
  console.log('design tabs after multi Ctrl+D:', designTabs);
  if (designTabs !== 2) fail(`expected 2 design tabs after multi Ctrl+D (hero 去重复用 + item), got ${designTabs}`);
  await page.screenshot({ path: 'output/smoke-ctrl-d-design-tabs.png' });
}

async function smokeComparison() {
  // 切回首页标签（Ctrl+D 后停留在设计标签上）
  await page.locator('.wb-tab:not(:has(.wb-tab-kind))').first().click();
  await page.waitForTimeout(400);
  // 打开批量导入对话框
  await page.locator('button[aria-label="批量导入"]').first().click();
  const dialog = page.locator('.wb-batch-transfer-dialog');
  await dialog.waitFor({ timeout: 5000 });

  // 上传构造好的 xlsx
  await page.locator('input[type="file"]').setInputFiles({
    name: 'smoke-import.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: buildImportBuffer(),
  });
  await page.waitForTimeout(1200);

  // 确保 hero 行已匹配目标表并勾选
  const sheetRow = dialog.locator('.wb-batch-transfer-row', { hasText: 'hero' }).first();
  await sheetRow.waitFor({ timeout: 5000 });
  const targetValue = await sheetRow.locator('select').inputValue();
  console.log('sheet target table:', targetValue);
  if (targetValue !== 'hero') await sheetRow.locator('select').selectOption('hero');
  const checkbox = sheetRow.locator('input[type="checkbox"]');
  if (!(await checkbox.isChecked())) await checkbox.click();

  // 运行对比
  await dialog.locator('.wb-batch-compare-action').click();
  const grid = dialog.locator('.wb-batch-diff').first();
  await grid.locator('.wb-batch-diff-body').waitFor({ timeout: 15000 });

  // 断言：对话框进入放大模式
  const dialogClass = await dialog.getAttribute('class');
  if (!dialogClass.includes('is-comparison-mode')) fail(`dialog not enlarged: ${dialogClass}`);

  // 断言：左右分屏各占约一半，两个窗格都有独立横向滚动能力
  const groupHeaders = await grid.locator('.wb-batch-diff-caption').allInnerTexts();
  console.log('group headers:', JSON.stringify(groupHeaders));
  if (!groupHeaders.some((t) => t.includes('Excel 导入数据'))) fail('missing Excel group header');
  if (!groupHeaders.some((t) => t.includes('数据库当前数据'))) fail('missing DB group header');
  const afterBox = await grid.locator('.wb-batch-diff-pane.is-after').boundingBox();
  const beforeBox = await grid.locator('.wb-batch-diff-pane.is-before').boundingBox();
  console.log('pane widths:', Math.round(afterBox.width), Math.round(beforeBox.width));
  if (Math.abs(afterBox.width - beforeBox.width) > 24) fail('panes are not half-and-half');

  // 断言：纵向滚动同步（左窗格滚动 → 右窗格跟随），横向滚动互不影响
  const scrollProbe = await page.evaluate(() => new Promise((resolve) => {
    const after = document.querySelector('.wb-batch-diff-pane.is-after');
    const before = document.querySelector('.wb-batch-diff-pane.is-before');
    const afterHead = document.querySelector('.wb-batch-diff-heads .wb-batch-diff-pane-head:not(.is-before) .wb-batch-diff-cols');
    after.scrollTop = 300;
    after.dispatchEvent(new Event('scroll'));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const syncedTop = before.scrollTop;
      after.scrollLeft = 380;
      after.dispatchEvent(new Event('scroll'));
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({
        syncedTop,
        beforeLeft: before.scrollLeft,
        afterHeadLeft: afterHead.scrollLeft,
      })));
    }));
  }));
  console.log('scroll probe:', JSON.stringify(scrollProbe));
  if (Math.abs(scrollProbe.syncedTop - 300) > 2) fail(`vertical scroll not synced: ${scrollProbe.syncedTop}`);
  if (scrollProbe.beforeLeft !== 0) fail(`horizontal scroll leaked to the other pane: ${scrollProbe.beforeLeft}`);
  if (Math.abs(scrollProbe.afterHeadLeft - 380) > 2) fail(`column header did not mirror pane scroll: ${scrollProbe.afterHeadLeft}`);

  // 断言：无需点击即可看到变化明细（删除行直接渲染，未变化行不占位）
  const deletedCount = await grid.locator('.wb-batch-diff-pane.is-before .wb-batch-diff-row.is-deleted').count();
  console.log('deleted rows visible:', deletedCount);
  if (deletedCount < 1) fail('expected deleted rows (rows missing from Excel)');
  const deletedBefore = await grid.locator('.wb-batch-diff-cell.is-before.is-changed').count();
  if (deletedBefore < 1) fail('expected red-tinted cells on the DB side of deleted rows');

  // 用状态过滤切换到「修改」：验证更新的行两侧着色
  await dialog.locator('.wb-batch-comparison-filters button', { hasText: '修改' }).click();
  await page.waitForTimeout(400);
  const updatedCount = await grid.locator('.wb-batch-diff-pane.is-after .wb-batch-diff-row.is-updated').count();
  console.log('updated rows:', updatedCount);
  if (updatedCount < 1) fail('expected an updated row');
  const changedAfter = await grid.locator('.wb-batch-diff-cell.is-after.is-changed').count();
  const changedBefore = await grid.locator('.wb-batch-diff-cell.is-before.is-changed').count();
  console.log('changed cells after/before:', changedAfter, changedBefore);
  if (changedAfter < 1 || changedBefore < 1) fail('expected tinted changed cells on both sides');

  // 「新增」：左侧整行着色、右侧整行占位提示
  await dialog.locator('.wb-batch-comparison-filters button', { hasText: '新增' }).click();
  await page.waitForTimeout(400);
  const insertedCount = await grid.locator('.wb-batch-diff-pane.is-after .wb-batch-diff-row.is-inserted').count();
  console.log('inserted rows:', insertedCount);
  if (insertedCount < 1) fail('expected an inserted row');
  if ((await grid.locator('.wb-batch-diff-row.is-inserted .wb-batch-diff-cell.is-after.is-changed').count()) < 1) {
    fail('expected green-tinted cells on the Excel side of inserted rows');
  }
  if ((await grid.locator('.wb-batch-diff-pane.is-before .wb-batch-diff-cell.is-placeholder-row').count()) < 1) {
    fail('expected a placeholder row on the DB side of inserted rows');
  }
  // 回到全部，截完整对比图
  await dialog.locator('.wb-batch-comparison-filters button', { hasText: '全部' }).first().click();
  await page.waitForTimeout(300);

  await page.screenshot({ path: 'output/smoke-comparison-light.png', fullPage: false });
  console.log('light comparison screenshot saved');
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await ensureHomePage();
  await smokeCtrlD();
  await smokeComparison();

  // 暗色主题下再看一眼对比视图
  await page.evaluate(() => localStorage.setItem('dbscout_theme', 'dark'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await ensureHomePage();
  await page.locator('button[aria-label="批量导入"]').first().click();
  const dialog = page.locator('.wb-batch-transfer-dialog');
  await dialog.waitFor({ timeout: 5000 });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'smoke-import.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: buildImportBuffer(),
  });
  await page.waitForTimeout(1200);
  await dialog.locator('.wb-batch-compare-action').click();
  await dialog.locator('.wb-batch-diff .wb-batch-diff-body').first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: 'output/smoke-comparison-dark.png', fullPage: false });
  console.log('dark comparison screenshot saved');
} finally {
  await browser.close();
}
console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE OK');
