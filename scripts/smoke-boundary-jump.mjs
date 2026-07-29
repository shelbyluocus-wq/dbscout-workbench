// 冒烟验证：边界跳转浮动按钮 + 跳到末行后向上滚动无缝前插上一页（mock perf 模式）。
// 注意：网格是虚拟滚动，DOM 只渲染可视区 ±10 行缓冲，因此用"首渲染行递减 +
// 滚动锚定值精确等于 1000×28 + 末行保持 10000"来断言窗口前插，而不是断言具体行号。
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

const grid = () => page.locator('.wb-grid-wrap').first();
const idCells = () => grid().locator('tbody tr td[data-column-name="id"]');
const firstId = async () => Number((await idCells().first().innerText()).trim());
const lastId = async () => Number((await idCells().last().innerText()).trim());

try {
  await page.goto('http://127.0.0.1:1431/?perfProfile=deterministic-v1&scenario=rows-10k-20-pk', {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('.mysql-workbench').waitFor({ state: 'visible', timeout: 20000 });

  const tableRow = page.locator('.wb-dbhome-object-row[data-table-name="perf_rows_10k_20_pk"] .wb-dbhome-object-name-button');
  await tableRow.waitFor({ state: 'visible', timeout: 20000 });
  await tableRow.dblclick();
  await grid().waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('td[data-row-key][data-column-name]').first().waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(400);

  // 1) 旧竖条已移除；打开 1 万行的表（只加载前 1000 行）应出现"末行"胶囊、无"首行"胶囊
  if (await page.locator('.wb-grid-boundary-nav').count()) fail('old boundary nav strip should be removed');
  const bottomPill = page.locator('.wb-grid-boundary-pill', { hasText: '末行' });
  await bottomPill.waitFor({ state: 'visible', timeout: 3000 });
  if (await page.locator('.wb-grid-boundary-pill', { hasText: '首行' }).count()) {
    fail('top pill should stay hidden at the very top');
  }
  console.log('fresh table: bottom pill visible, top pill hidden, first id =', await firstId());

  // 2) 点击"末行"→ 窗口替换为最后一页：末行是 10000，出现"首行"胶囊
  await bottomPill.click();
  await page.waitForTimeout(900);
  const bottomLast = await lastId();
  console.log('after jump-to-bottom: last id =', bottomLast);
  if (bottomLast !== 10000) fail(`expected last id 10000 at bottom, got ${bottomLast}`);
  const topPill = page.locator('.wb-grid-boundary-pill', { hasText: '首行' });
  await topPill.waitFor({ state: 'visible', timeout: 3000 });
  await page.screenshot({ path: 'output/boundary-jump-bottom.png' });
  console.log('top pill visible after jump: ok, screenshot saved');

  // 3) 滚到窗口顶部 → 自动前插上一页：首渲染行上移，滚动锚定 = 1000 行 × 28px，末行仍是 10000
  const firstBefore = await firstId();
  await grid().evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const firstAfter1 = await firstId();
  const anchor1 = await grid().evaluate((el) => el.scrollTop);
  console.log(`prepend #1: first id ${firstBefore} -> ${firstAfter1}, anchor scrollTop = ${anchor1}`);
  if (!(firstAfter1 < firstBefore)) fail('window should grow upward after scrolling to top');
  if (anchor1 !== 28000) fail(`scroll anchor should be 28000 (1000 rows x 28px), got ${anchor1}`);

  // 4) 继续向上 → 再前插一页
  await grid().evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const firstAfter2 = await firstId();
  const anchor2 = await grid().evaluate((el) => el.scrollTop);
  console.log(`prepend #2: first id ${firstAfter1} -> ${firstAfter2}, anchor scrollTop = ${anchor2}`);
  if (!(firstAfter2 < firstAfter1)) fail('window should keep growing upward');
  if (anchor2 !== 28000) fail(`scroll anchor should be 28000 again, got ${anchor2}`);

  // 5) 点"首行"→ 回到表顶（首行 id = 1），"末行"胶囊重新出现
  await topPill.click();
  await page.waitForTimeout(900);
  const topFirst = await firstId();
  console.log('after jump-to-top: first id =', topFirst);
  if (topFirst !== 1) fail(`expected first id 1 after jump-to-top, got ${topFirst}`);
  await page.locator('.wb-grid-boundary-pill', { hasText: '末行' }).waitFor({ state: 'visible', timeout: 3000 });

  console.log('DONE');
} catch (error) {
  fail(error?.message || String(error));
} finally {
  await browser.close();
}
