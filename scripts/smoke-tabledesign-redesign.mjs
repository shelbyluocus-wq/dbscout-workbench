// 冒烟：表设计器重设计截图（mock 模式，明暗双主题）。
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

async function openDesign() {
  const tableItem = page.locator('.wb-tree-row.wb-table-item[data-table-name="hero"]').first();
  await tableItem.scrollIntoViewIfNeeded();
  await tableItem.click({ button: 'right' });
  await page.waitForTimeout(350);
  await page.locator('.wb-context-menu button', { hasText: '表设计' }).click();
  const editor = page.locator('.wb-design-editor');
  await editor.waitFor({ timeout: 5000 });
  await editor.locator('.wb-design-grid tbody tr').first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  return editor;
}

async function verify(editor) {
  // 字段名输入框与类型下拉应在同一水平线上
  const [nameBox, typeBox] = await Promise.all([
    editor.locator('.wb-design-name-cell input').first().boundingBox(),
    editor.locator('.wb-design-grid tbody tr td:nth-child(3) select').first().boundingBox(),
  ]);
  if (!nameBox || !typeBox) fail('name/type controls not found');
  else if (Math.abs(nameBox.y - typeBox.y) > 2) fail(`name/type misaligned: ${nameBox.y} vs ${typeBox.y}`);
  // 拖拽把手在输入框左侧
  const handleBox = await editor.locator('.wb-design-drag-handle').first().boundingBox();
  if (!handleBox || handleBox.x >= nameBox.x) fail('drag handle is not left of the name input');
  // 网格容器不应留出大块空白（高度贴合内容）
  const metrics = await editor.evaluate((root) => {
    const wrap = root.querySelector('.wb-design-grid-wrap');
    const table = root.querySelector('.wb-design-grid');
    return { wrap: wrap.clientHeight, table: table.offsetHeight };
  });
  console.log('grid wrap/table heights:', JSON.stringify(metrics));
  if (metrics.wrap - metrics.table > 40) fail(`grid wrap leaves ${metrics.wrap - metrics.table}px empty canvas`);
  // 备注编辑按钮应有显眼配色
  const expandStyle = await editor.locator('.wb-design-comment-expand').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { background: cs.backgroundColor, color: cs.color };
  });
  console.log('comment expand style:', JSON.stringify(expandStyle));
  if (expandStyle.background === 'rgba(0, 0, 0, 0)') fail('comment expand button still transparent');
}

try {
  // ── 亮色主题 ──
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await ensureSidebar();
  let editor = await openDesign();
  await verify(editor);
  await page.screenshot({ path: 'output/redesign-tabledesign-light.png' });
  console.log('light screenshot saved');
  await editor.locator('.wb-design-grid-wrap').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(300);
  await editor.screenshot({ path: 'output/redesign-tabledesign-comment-light.png' });

  // ── 暗色主题 ──
  await page.evaluate(() => localStorage.setItem('dbscout_theme', 'dark'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await ensureSidebar();
  editor = await openDesign();
  await verify(editor);
  await page.screenshot({ path: 'output/redesign-tabledesign-dark.png' });
  console.log('dark screenshot saved');
  await editor.locator('.wb-design-grid-wrap').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(300);
  await editor.screenshot({ path: 'output/redesign-tabledesign-comment-dark.png' });
} finally {
  await browser.close();
}
console.log(process.exitCode ? 'SMOKE TABLEDESIGN FAILED' : 'SMOKE TABLEDESIGN OK');
