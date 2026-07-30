// 冒烟验证：边界跳转浮动按钮 + 跳到末行后用真实滚轮手势向上无缝前插
// 上一页（mock perf 模式）。网格是虚拟滚动，DOM 只渲染可视区 ±10 行缓冲，
// 因此用加载窗口范围、非空可视行和滚动锚定断言，不依赖某个固定首渲染行。
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

const grid = () => page.locator('.wb-grid-wrap').first();
const idCells = () => grid().locator('tbody tr td[data-column-name="id"]');
const firstId = async () => Number((await idCells().first().innerText()).trim());
const lastId = async () => Number((await idCells().last().innerText()).trim());
const loadedRange = () => grid().locator('.wb-grid-loadmore-cell.is-done');

async function wheelUpOneWindow(expectedRange) {
  await grid().hover();
  await page.mouse.wheel(0, -40000);
  await loadedRange().filter({ hasText: expectedRange }).waitFor({ state: 'attached', timeout: 5000 });
  await page.waitForTimeout(100);
  const metrics = await grid().evaluate((el) => ({
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    rowCount: el.querySelectorAll('tbody tr td[data-column-name="id"]').length,
    visibleRowCount: [...el.querySelectorAll('tbody tr.wb-grid-row')].filter((row) => {
      const rowRect = row.getBoundingClientRect();
      const wrapRect = el.getBoundingClientRect();
      const headerBottom = el.querySelector('thead')?.getBoundingClientRect().bottom || wrapRect.top;
      return rowRect.bottom > headerBottom && rowRect.top < wrapRect.bottom;
    }).length,
  }));
  if (metrics.scrollTop <= 0) fail(`reverse prepend should restore scrollTop for ${expectedRange}`);
  if (metrics.rowCount <= 0) fail(`grid must not render blank while loading ${expectedRange}`);
  if (metrics.visibleRowCount <= 0) fail(`grid rows must intersect the viewport for ${expectedRange}`);
  return metrics;
}

async function assertSilentResetRestoresAnchor(anchorMetrics) {
  await grid().evaluate((el) => {
    el.addEventListener('scroll', (event) => event.stopImmediatePropagation(), {
      capture: true,
      once: true,
    });
    el.scrollTop = 0;
  });
  await page.waitForFunction((expectedTop) => {
    const el = document.querySelector('.wb-grid-wrap');
    return el && Math.abs(el.scrollTop - expectedTop) < 1;
  }, anchorMetrics.scrollTop, { timeout: 1500 });
  const repaired = await grid().evaluate((el) => {
    const wrapRect = el.getBoundingClientRect();
    const headerBottom = el.querySelector('thead')?.getBoundingClientRect().bottom || wrapRect.top;
    const visibleRows = [...el.querySelectorAll('tbody tr.wb-grid-row')].filter((row) => {
      const rowRect = row.getBoundingClientRect();
      return rowRect.bottom > headerBottom && rowRect.top < wrapRect.bottom;
    });
    return {
      scrollTop: el.scrollTop,
      firstVisibleId: Number(visibleRows[0]?.querySelector('td[data-column-name="id"]')?.textContent?.trim()),
      visibleRowCount: visibleRows.length,
    };
  });
  if (Math.abs(repaired.scrollTop - anchorMetrics.scrollTop) >= 1) {
    fail(`silent native reset must restore anchor ${anchorMetrics.scrollTop}, got ${repaired.scrollTop}`);
  }
  if (repaired.visibleRowCount <= 0) fail('silent native reset must keep rows visible');
  return repaired;
}

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

  // 3) 单次真实向上滚轮必须在同一手势内前插上一页，不允许停在硬顶等待第二次手势。
  const firstBefore = await firstId();
  const metrics1 = await wheelUpOneWindow('第 8001–10000 行');
  const firstAfter1 = await firstId();
  console.log(`prepend #1: first id ${firstBefore} -> ${firstAfter1}, anchor scrollTop = ${metrics1.scrollTop}`);
  if (!(firstAfter1 < firstBefore)) fail('window should grow upward after scrolling to top');
  const repairedAnchor = await assertSilentResetRestoresAnchor(metrics1);
  console.log(`silent reset repaired: first visible id = ${repairedAnchor.firstVisibleId}`);

  // 4) 第二个真实手势继续跨下一批，锚定后仍有可视内容。
  const metrics2 = await wheelUpOneWindow('第 7001–10000 行');
  const firstAfter2 = await firstId();
  console.log(`prepend #2: first id ${firstAfter1} -> ${firstAfter2}, anchor scrollTop = ${metrics2.scrollTop}`);
  if (!(firstAfter2 < firstAfter1)) fail('window should keep growing upward');

  // 5) 点"首行"→ 回到表顶（首行 id = 1），"末行"胶囊重新出现
  await topPill.click();
  await page.waitForTimeout(900);
  const topFirst = await firstId();
  console.log('after jump-to-top: first id =', topFirst);
  if (topFirst !== 1) fail(`expected first id 1 after jump-to-top, got ${topFirst}`);
  await page.locator('.wb-grid-boundary-pill', { hasText: '末行' }).waitFor({ state: 'visible', timeout: 3000 });

  // 6) 末页短于一个视口时不会产生 scroll 事件，首次向上 wheel 仍须接回上一批。
  await page.goto('http://127.0.0.1:1431/?perfProfile=deterministic-v1&scenario=rows-10017-20-pk', {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('.mysql-workbench').waitFor({ state: 'visible', timeout: 20000 });
  const shortPageTable = page.locator('.wb-dbhome-object-row[data-table-name="perf_rows_10017_20_pk"] .wb-dbhome-object-name-button');
  await shortPageTable.waitFor({ state: 'visible', timeout: 20000 });
  await shortPageTable.dblclick();
  await grid().waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('td[data-row-key][data-column-name]').first().waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('.wb-grid-boundary-pill', { hasText: '末行' }).click();
  await loadedRange().filter({ hasText: '第 10001–10017 行' }).waitFor({ state: 'attached', timeout: 5000 });
  const shortPageBefore = await grid().evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  if (shortPageBefore.scrollTop !== 0 || shortPageBefore.scrollHeight > shortPageBefore.clientHeight) {
    fail(`expected a non-scrollable 17-row final page, got ${JSON.stringify(shortPageBefore)}`);
  }
  const shortPageMetrics = await wheelUpOneWindow('第 9001–10017 行');
  console.log(`short final page prepend: anchor scrollTop = ${shortPageMetrics.scrollTop}`);

  console.log('DONE');
} catch (error) {
  fail(error?.message || String(error));
} finally {
  await browser.close();
}
