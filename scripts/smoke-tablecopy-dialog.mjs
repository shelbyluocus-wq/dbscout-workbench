// 冒烟：发送表对话框重设计截图（mock 模式，明暗双主题）。
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

async function ensureSidebar() {
  const dbItem = page.locator('.wb-tree-row.wb-database-item').first();
  if (!(await dbItem.isVisible().catch(() => false))) {
    await page.locator('.wb-titlebar-sidebar .wb-topbar-collapse-btn').click();
    await page.waitForTimeout(800);
  }
}

async function openDialog() {
  const tableItem = page.locator('.wb-tree-row.wb-table-item[data-table-name="hero"]').first();
  await tableItem.scrollIntoViewIfNeeded();
  await tableItem.click({ button: 'right' });
  await page.waitForTimeout(350);
  await page.locator('.wb-context-menu button', { hasText: '发送到' }).click();
  const dialog = page.locator('.wb-table-copy-dialog');
  await dialog.waitFor({ timeout: 4000 });
  await dialog.locator('.wb-table-copy-row').first().waitFor({ timeout: 4000 });
  return dialog;
}

async function populate(dialog) {
  // 右键的 hero 已预选，再按表名勾选两行（对话框内列表顺序与侧栏不同，不能按下标点）
  for (const name of ['monster', 'guild']) {
    await dialog.locator('.wb-table-copy-row', { hasText: name }).first().click();
  }
  await page.waitForTimeout(250);
}

async function verify(dialog) {
  const cols = await dialog.locator('.wb-table-copy-columns').innerText();
  if (!cols.includes('表名') || !cols.includes('备注')) fail(`column header broken: ${cols}`);
  const selected = await dialog.locator('.wb-table-copy-selection-row').count();
  console.log('selected rows in panel:', selected);
  if (selected < 2) fail(`expected >=2 selected rows, got ${selected}`);
  const primary = dialog.locator('button.wb-dialog-primary', { hasText: '发送所选表' });
  if ((await primary.count()) !== 1) fail('send button is not the accent primary');
  if (await dialog.locator('.wb-database-sync-danger').count()) fail('danger class still present');
  // 回归验证：禁用主按钮不再套用灰字+降透明度，保持可读且一眼可辨禁用
  const disabledStyle = await primary.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { opacity: cs.opacity, color: cs.color, background: cs.backgroundColor, filter: cs.filter, cursor: cs.cursor };
  });
  console.log('disabled primary style:', JSON.stringify(disabledStyle));
  if (disabledStyle.opacity !== '1') fail(`disabled primary opacity ${disabledStyle.opacity}`);
  if (!disabledStyle.filter.includes('saturate')) fail(`disabled primary not grayed: ${disabledStyle.filter}`);
  if (disabledStyle.cursor !== 'not-allowed') fail(`disabled primary cursor ${disabledStyle.cursor}`);
  // 禁用时包裹层应给出原因 tooltip
  const hint = await primary.evaluate((el) => el.closest('.wb-table-copy-send-hint')?.getAttribute('title') || '');
  console.log('send disabled hint:', hint);
  if (!hint.includes('目标数据库') && !hint.includes('勾选')) fail(`missing disabled reason tooltip: ${hint}`);
}

try {
  // ── 亮色主题 ──
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await ensureSidebar();
  let dialog = await openDialog();
  await populate(dialog);
  await verify(dialog);
  await page.screenshot({ path: 'output/redesign-tablecopy-light.png' });
  console.log('light screenshot saved');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ── 暗色主题 ──
  await page.evaluate(() => localStorage.setItem('dbscout_theme', 'dark'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await ensureSidebar();
  dialog = await openDialog();
  await populate(dialog);
  await page.screenshot({ path: 'output/redesign-tablecopy-dark.png' });
  console.log('dark screenshot saved');
} finally {
  await browser.close();
}
console.log(process.exitCode ? 'SMOKE TABLECOPY FAILED' : 'SMOKE TABLECOPY OK');
