// 冒烟：首页 Ctrl+D 打开表设计（含多选）+ 批量导入「对比变化」双栏 diff 视图（mock 模式）。
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';

const BASE = `http://127.0.0.1:${process.env.SMOKE_PORT || 1431}/`;

const browser = await chromium.launch({
  headless: true,
  ...(process.env.SMOKE_BROWSER_CHANNEL ? { channel: process.env.SMOKE_BROWSER_CHANNEL } : {}),
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

async function waitForText(locator, expected, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await locator.textContent().catch(() => ""))?.trim() === expected) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`等待文字失败：${expected}`);
}

async function selectSearchMode(comparison, label) {
  await comparison.locator('.wb-search-mode-control button').click();
  const menu = page.getByRole('menu', { name: '搜索匹配方式' });
  await menu.getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click();
}

function buildImportBuffer() {
  const workbook = XLSX.utils.book_new();
  // hero: id=1 改名字（修改），id=999999 新增；其余数据库现有行会成为“删除”。
  // mock 校验要求所有非空字段都有值，所以带齐 hero 的必填列。
  // description 放一段长文本，用于验证单元格详情栏能看到完整值。
  const longText = `向导长文本：${"这是一段用于验证详情栏的长文本。".repeat(12)}`;
  const header = ['id', 'name', 'rarity', 'element', 'hp_base', 'atk_base', 'def_base', 'spd_base', 'skill_id', 'is_available', 'description'];
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      header,
      ['1', '冒烟改名英雄', '5', '火', '1000', '100', '50', '110', '1001', '1', longText],
      ['999999', '冒烟新增英雄', '4', '水', '900', '90', '40', '105', '1002', '1', '新增行描述'],
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

  // 断言：进入对比后自动定位并选中首个改动单元格（首个改动行在第 499 位，
  // 超出默认 200 条渲染窗口，必须自动扩窗并滚动到位）
  const autoJump = await page.evaluate(() => ({
    afterTop: document.querySelector('.wb-batch-diff-pane.is-after .wb-batch-diff-main').scrollTop,
    selected: document.querySelectorAll('.wb-batch-diff .wb-batch-diff-cell.is-selected').length,
    updatedRows: document.querySelectorAll('.wb-batch-diff .wb-batch-diff-main .wb-batch-diff-row.is-updated').length,
    detailColumn: document.querySelector('.wb-batch-diff-detail-header strong')?.textContent || '',
  }));
  console.log('auto jump:', JSON.stringify(autoJump));
  if (autoJump.afterTop < 1000) fail(`did not jump to the first changed row (scrollTop: ${autoJump.afterTop})`);
  if (autoJump.selected < 2) fail(`first changed cell not auto-selected in both panes (${autoJump.selected})`);
  if (autoJump.updatedRows < 1) fail('first changed row not rendered after auto-expanding the window');
  if (!autoJump.detailColumn) fail('detail bar not populated by the auto-selection');

  // 断言：meta 栏（状态/主键列）已移除，两个窗格各占约一半
  const groupHeaders = await grid.locator('.wb-batch-diff-caption').allInnerTexts();
  console.log('group headers:', JSON.stringify(groupHeaders));
  if (!groupHeaders.some((t) => t.includes('Excel 导入数据'))) fail('missing Excel group header');
  if (!groupHeaders.some((t) => t.includes('数据库当前数据'))) fail('missing DB group header');
  if ((await grid.locator('.wb-batch-diff-meta-col').count()) !== 0) fail('meta column should be removed');
  const afterBox = await grid.locator('.wb-batch-diff-pane.is-after').boundingBox();
  const beforeBox = await grid.locator('.wb-batch-diff-pane.is-before').boundingBox();
  console.log('pane widths:', Math.round(afterBox.width), Math.round(beforeBox.width));
  if (Math.abs(afterBox.width - beforeBox.width) > 24) fail('panes are not half-and-half');

  // 对比内搜索：快捷键、三种模式、双边高亮、上下跳转、主键开关和清空恢复。
  const comparison = page.locator('.wb-batch-comparison');
  const searchInput = comparison.getByRole('searchbox', { name: /搜索当前表/ });
  const hitCount = comparison.locator('.wb-search-hit-count');
  const originTop = await grid.locator('.wb-batch-diff-pane.is-after .wb-batch-diff-main').evaluate((el) => el.scrollTop);
  await comparison.locator('.wb-batch-diff-section-header').click();
  await page.keyboard.press('Control+f');
  if (!(await searchInput.evaluate((el) => el === document.activeElement))) fail('Ctrl+F did not focus comparison search');
  if (await page.locator('.wb-find-replace-dialog:visible').count()) fail('Ctrl+F also opened the outer find dialog');

  await searchInput.fill('冒烟');
  await waitForText(hitCount, '1/2');
  if ((await grid.locator('.wb-batch-diff-cell mark').count()) !== 2) fail('continuous search did not highlight both matching cells');
  if ((await grid.locator('.wb-batch-diff-cell.is-search-current').count()) !== 1) fail('current search hit is not distinct');
  await comparison.getByRole('button', { name: '下一个匹配' }).click();
  await waitForText(hitCount, '2/2');
  await comparison.getByRole('button', { name: '上一个匹配' }).click();
  await waitForText(hitCount, '1/2');

  await selectSearchMode(comparison, '精确');
  await waitForText(hitCount, '0/0');
  await searchInput.fill('冒烟改名英雄');
  await waitForText(hitCount, '1/1');
  await selectSearchMode(comparison, '连续');
  await searchInput.fill('烟改');
  await waitForText(hitCount, '1/1');
  await selectSearchMode(comparison, '模糊');
  await searchInput.fill('烟英');
  await waitForText(hitCount, '1/2');

  await selectSearchMode(comparison, '精确');
  await searchInput.fill('999999');
  await waitForText(hitCount, '1/1');
  const primaryKeyToggle = comparison.getByLabel('显示主键');
  await primaryKeyToggle.uncheck();
  await waitForText(hitCount, '0/0');
  await primaryKeyToggle.check();
  await waitForText(hitCount, '1/1');

  await searchInput.fill('');
  await page.waitForTimeout(250);
  const restoredTop = await grid.locator('.wb-batch-diff-pane.is-after .wb-batch-diff-main').evaluate((el) => el.scrollTop);
  if (Math.abs(restoredTop - originTop) > 2) fail(`clearing search did not restore scroll: ${originTop} -> ${restoredTop}`);

  // “全部行”保留查询和模式，并自动把剩余内容读完后给出准确结果。
  await searchInput.fill('冒烟新增英雄');
  await waitForText(hitCount, '1/1');
  await comparison.getByRole('button', { name: '全部行' }).click();
  if ((await searchInput.inputValue()) !== '冒烟新增英雄') fail('query did not persist after switching comparison view');
  if (!(await comparison.locator('.wb-search-mode-control button').innerText()).includes('精确')) fail('search mode did not persist');
  await page.waitForFunction(() => {
    const text = document.querySelector('.wb-batch-comparison-load-state')?.textContent || '';
    const match = text.match(/已加载\s+(\d+)\s*\/\s*(\d+)\s*行/);
    return Boolean(match && Number(match[1]) === Number(match[2]) && Number(match[1]) >= 500);
  });
  await waitForText(hitCount, '1/1', 10000);
  await comparison.getByRole('tab', { name: /新增/ }).click();
  if ((await searchInput.inputValue()) !== '冒烟新增英雄') fail('query did not persist after switching status');
  await waitForText(hitCount, '1/1');
  await comparison.getByRole('button', { name: '全屏对比' }).click();
  if (!(await comparison.getAttribute('class')).includes('is-fullscreen')) fail('comparison did not enter fullscreen');
  await selectSearchMode(comparison, '连续');
  await waitForText(hitCount, '1/1');
  await selectSearchMode(comparison, '精确');
  await page.screenshot({ path: 'output/smoke-comparison-search-fullscreen.png', fullPage: false });
  await comparison.getByRole('button', { name: '退出全屏' }).click();
  await page.screenshot({ path: 'output/smoke-comparison-search.png', fullPage: false });
  await searchInput.fill('');
  await comparison.getByRole('button', { name: '只看差别' }).click();
  await comparison.getByRole('tab', { name: /全部类型/ }).click();

  // 断言：纵向+横向滚动都联动，冻结主键块纹丝不动，列表头镜像横滚
  const scrollProbe = await page.evaluate(() => new Promise((resolve) => {
    const after = document.querySelector('.wb-batch-diff-pane.is-after .wb-batch-diff-main');
    const before = document.querySelector('.wb-batch-diff-pane.is-before .wb-batch-diff-main');
    const beforeFrozen = document.querySelector('.wb-batch-diff-pane.is-before .wb-batch-diff-frozen');
    const afterHead = document.querySelector('.wb-batch-diff-heads .wb-batch-diff-pane-head:not(.is-before) .wb-batch-diff-cols');
    const frozenStartX = beforeFrozen.getBoundingClientRect().x;
    after.scrollTop = 300;
    after.dispatchEvent(new Event('scroll'));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const syncedTop = before.scrollTop;
      const frozenSyncedTop = beforeFrozen.scrollTop;
      after.scrollLeft = 380;
      after.dispatchEvent(new Event('scroll'));
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({
        syncedTop,
        frozenSyncedTop,
        beforeLeft: before.scrollLeft,
        afterHeadLeft: afterHead.scrollLeft,
        frozenStartX,
        frozenX: beforeFrozen.getBoundingClientRect().x,
      })));
    }));
  }));
  console.log('scroll probe:', JSON.stringify(scrollProbe));
  if (Math.abs(scrollProbe.syncedTop - 300) > 2) fail(`vertical scroll not synced: ${scrollProbe.syncedTop}`);
  if (Math.abs(scrollProbe.frozenSyncedTop - 300) > 2) fail(`frozen block vertical scroll not synced: ${scrollProbe.frozenSyncedTop}`);
  if (Math.abs(scrollProbe.beforeLeft - 380) > 2) fail(`horizontal scroll not linked: ${scrollProbe.beforeLeft}`);
  if (Math.abs(scrollProbe.afterHeadLeft - 380) > 2) fail(`column header did not mirror pane scroll: ${scrollProbe.afterHeadLeft}`);
  if (Math.abs(scrollProbe.frozenX - scrollProbe.frozenStartX) > 2) {
    fail(`frozen pk block drifted horizontally: ${scrollProbe.frozenStartX} -> ${scrollProbe.frozenX}`);
  }

  // 断言：无需点击即可看到变化明细（删除行直接渲染，未变化行不占位）
  const deletedCount = await grid.locator('.wb-batch-diff-pane.is-before .wb-batch-diff-main .wb-batch-diff-row.is-deleted').count();
  console.log('deleted rows visible:', deletedCount);
  if (deletedCount < 1) fail('expected deleted rows (rows missing from Excel)');
  const deletedBefore = await grid.locator('.wb-batch-diff-cell.is-before.is-changed').count();
  if (deletedBefore < 1) fail('expected red-tinted cells on the DB side of deleted rows');

  // 用状态过滤切换到「修改」：验证更新的行两侧着色
  await dialog.locator('.wb-batch-comparison-filters button', { hasText: '修改' }).click();
  await page.waitForTimeout(400);
  const updatedCount = await grid.locator('.wb-batch-diff-pane.is-after .wb-batch-diff-main .wb-batch-diff-row.is-updated').count();
  console.log('updated rows:', updatedCount);
  if (updatedCount < 1) fail('expected an updated row');
  const changedAfter = await grid.locator('.wb-batch-diff-cell.is-after.is-changed').count();
  const changedBefore = await grid.locator('.wb-batch-diff-cell.is-before.is-changed').count();
  console.log('changed cells after/before:', changedAfter, changedBefore);
  if (changedAfter < 1 || changedBefore < 1) fail('expected tinted changed cells on both sides');

  // 「新增」：左侧整行着色、右侧整行占位提示
  await dialog.locator('.wb-batch-comparison-filters button', { hasText: '新增' }).click();
  await page.waitForTimeout(400);
  const insertedCount = await grid.locator('.wb-batch-diff-pane.is-after .wb-batch-diff-main .wb-batch-diff-row.is-inserted').count();
  console.log('inserted rows:', insertedCount);
  if (insertedCount < 1) fail('expected an inserted row');
  if ((await grid.locator('.wb-batch-diff-row.is-inserted .wb-batch-diff-cell.is-after.is-changed').count()) < 1) {
    fail('expected green-tinted cells on the Excel side of inserted rows');
  }
  if ((await grid.locator('.wb-batch-diff-pane.is-before .wb-batch-diff-cell.is-placeholder-row').count()) < 1) {
    fail('expected a placeholder row on the DB side of inserted rows');
  }
  // 单元格详情栏：点击长文本单元格，底部常驻栏显示新旧全文，布局尺寸不变
  await dialog.locator('.wb-batch-comparison-filters button', { hasText: '修改' }).click();
  await page.waitForTimeout(300);
  const bodyEl = grid.locator('.wb-batch-diff-body');
  const heightBefore = await bodyEl.evaluate((el) => el.style.height);
  const longCell = grid.locator('.wb-batch-diff-cell.is-after[title*="向导长文本"]').first();
  await longCell.click();
  // 点击联动：同一列在另一侧窗格的单元格也被选中
  if ((await grid.locator('.wb-batch-diff-pane.is-before .wb-batch-diff-main .wb-batch-diff-row.is-updated .wb-batch-diff-cell.is-selected').count()) < 1) {
    fail('click did not select the mirrored cell in the other pane');
  }
  const detail = grid.locator('.wb-batch-diff-detail');
  await detail.locator('section').first().waitFor({ timeout: 3000 });
  const heightAfter = await bodyEl.evaluate((el) => el.style.height);
  console.log('body height before/after click:', heightBefore, heightAfter);
  if (heightBefore !== heightAfter) fail(`layout jumped when selecting a cell: ${heightBefore} -> ${heightAfter}`);
  const newText = await detail.locator('section').first().locator('pre').innerText();
  console.log('detail new value length:', newText.length);
  if (newText.length < 150) fail(`detail bar truncated the value: ${newText.length} chars`);
  const paneLabels = await detail.locator('label').allInnerTexts();
  console.log('detail labels:', JSON.stringify(paneLabels));
  if (!(paneLabels.some((t) => t.includes('Excel 导入数据')) && paneLabels.some((t) => t.includes('数据库当前数据')))) {
    fail('detail bar missing before/after labels');
  }
  // 关闭后回到常驻提示，详情栏本身保留
  await detail.locator('.wb-batch-diff-detail-header button').click();
  await page.waitForTimeout(200);
  if (!(await grid.locator('.wb-batch-diff-detail-hint').isVisible().catch(() => false))) {
    fail('detail bar did not return to the permanent hint state');
  }

  // 回到全部，截完整对比图
  await dialog.locator('.wb-batch-comparison-filters button', { hasText: '全部' }).first().click();
  await page.waitForTimeout(300);
  // 重新打开一个详情栏再截图，展示详情栏效果
  await grid.locator('.wb-batch-diff-cell.is-before[title*="炎龙骑士"]').first().click().catch(() => {});
  await page.waitForTimeout(250);

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
