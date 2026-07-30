import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
const bottomPill = () => page.locator('.wb-grid-boundary-pill--bottom');
const topPill = () => page.locator('.wb-grid-boundary-pill--top');
async function sampleY(locator, ms = 700, step = 40) {
  const ys = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const box = await locator.boundingBox().catch(() => null);
    if (box) ys.push(Math.round(box.y * 10) / 10);
    await page.waitForTimeout(step);
  }
  return ys;
}
try {
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'domcontentloaded' });
  await page.locator('.mysql-workbench').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('.wb-dbhome-object-row[data-table-name="player"] .wb-dbhome-object-name-button').dblclick();
  await page.locator('td[data-row-key][data-column-name]').first().waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(800);
  await bottomPill().waitFor({ state: 'visible', timeout: 3000 });

  // 场景 1：点「末行」→ 首行胶囊出现过程中，末行胶囊位置应纹丝不动
  const before1 = (await bottomPill().boundingBox()).y;
  await bottomPill().click();
  const ys1 = await sampleY(bottomPill(), 800);
  const dev1 = Math.max(...ys1.map((y) => Math.abs(y - before1)));
  console.log('click 末行: 末行 pill y 稳定值', before1, '最大偏移', dev1);
  if (dev1 > 5) fail(`末行 pill jumped by ${dev1}px during 首行 enter`);

  // 场景 2：点「首行」→ 首行离开、末行仍在底部槽位（之前会瞬间上移 36px）
  await topPill().waitFor({ state: 'visible', timeout: 3000 });
  await topPill().click();
  const ys2 = await sampleY(bottomPill(), 900);
  const final2 = ys2.at(-1);
  const dev2 = Math.max(...ys2.map((y) => Math.abs(y - final2)));
  console.log('click 首行: 末行 pill 最终 y', final2, '进入动画内最大偏移', dev2);
  if (dev2 > 6) fail(`末行 pill jumped by ${dev2}px (layout shift, not enter anim)`);
  await page.screenshot({ path: 'output/boundary-pill-motion.png' });
  console.log('DONE');
} catch (e) { fail(e?.message || String(e)); } finally { await browser.close(); }
