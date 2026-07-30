import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
try {
  // 演示表 player 只有 500 行（首屏自动加载即全部加载完），正是"旧逻辑要滑一下才出现"的场景
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'domcontentloaded' });
  await page.locator('.mysql-workbench').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('.wb-dbhome-object-row[data-table-name="player"] .wb-dbhome-object-name-button').dblclick();
  await page.locator('td[data-row-key][data-column-name]').first().waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(800);
  // 不做任何滚动，"末行"胶囊应立即可见
  const bottomPill = page.locator('.wb-grid-boundary-pill', { hasText: '末行' });
  await bottomPill.waitFor({ state: 'visible', timeout: 3000 });
  console.log('fresh open (no scroll): 末行 pill visible immediately: ok');
  // "首行"此时不应出现（就在顶部）
  if (await page.locator('.wb-grid-boundary-pill', { hasText: '首行' }).count()) fail('首行 pill should be hidden at top');
  // 点击末行 → 到底部后"末行"应消失、"首行"应出现
  await bottomPill.click();
  await page.waitForTimeout(900);
  if (await bottomPill.isVisible().catch(() => false)) fail('末行 pill should hide after reaching bottom');
  await page.locator('.wb-grid-boundary-pill', { hasText: '首行' }).waitFor({ state: 'visible', timeout: 3000 });
  console.log('after jump-to-bottom: 末行 hidden, 首行 visible: ok');
  // 点首行回到顶部 → "末行"应重新出现（即用户要的"刚进来就能跳末行"状态）
  await page.locator('.wb-grid-boundary-pill', { hasText: '首行' }).click();
  await page.waitForTimeout(900);
  await page.locator('.wb-grid-boundary-pill', { hasText: '末行' }).waitFor({ state: 'visible', timeout: 3000 });
  console.log('back at top: 末行 pill visible again: ok');
  await page.screenshot({ path: 'output/boundary-pill-fresh-open.png' });
  console.log('DONE');
} catch (e) { fail(e?.message || String(e)); } finally { await browser.close(); }
