// 回归冒烟：跳到末行后按住滚轮持续向上（含模拟后端时延）。
// 断言滚动总高度固定、持续向上手势中 scrollTop 不反增、可见行不反向跳，
// 且最终能逐页读取回到表顶。
// 用法: node scripts/smoke-boundary-wheel-hold.mjs [latencyMs]
import { chromium } from 'playwright';

const latencyMs = Number(process.argv[2] || 300);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
await page.addInitScript((ms) => { window.__DBSCOUT_MOCK_PAGE_LATENCY_MS__ = ms; }, latencyMs);

const grid = () => page.locator('.wb-grid-wrap').first();

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

  // 等待首屏缓冲填充结束，避免“末行”点击撞上 loadingMore 被 busy 吞掉。
  await page.waitForTimeout(latencyMs * 4 + 1200);
  await page.locator('.wb-grid-boundary-pill', { hasText: '末行' }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector('.wb-grid-wrap');
    if (!el) return false;
    const ids = [...el.querySelectorAll('tbody tr.wb-grid-row td[data-column-name="id"]')]
      .map((cell) => Number(cell.textContent.trim()));
    return ids.length > 0 && Math.max(...ids) === 10000;
  }, { timeout: 15000 });
  await page.waitForTimeout(300);

  // 页内逐帧记录器：scrollTop / scrollHeight / 首个可见行 id。
  await grid().evaluate((el) => {
    const readFirstVisibleId = () => {
      const wrapRect = el.getBoundingClientRect();
      const headerBottom = el.querySelector('thead')?.getBoundingClientRect().bottom || wrapRect.top;
      for (const row of el.querySelectorAll('tbody tr.wb-grid-row')) {
        const rowRect = row.getBoundingClientRect();
        if (rowRect.bottom > headerBottom && rowRect.top < wrapRect.bottom) {
          return Number(row.querySelector('td[data-column-name="id"]')?.textContent?.trim() || 0);
        }
      }
      return 0;
    };
    window.__scrollTimeline = [];
    let stopped = false;
    window.__stopRecorder = () => { stopped = true; };
    const tick = () => {
      if (stopped) return;
      window.__scrollTimeline.push({
        t: performance.now(),
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        firstId: readFirstVisibleId(),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // 按住滚轮持续向上：真实鼠标连击节奏，一路滚到表顶为止（带轮次上限）。
  await grid().hover();
  const readFirstVisibleIdNow = () => grid().evaluate((el) => {
    const wrapRect = el.getBoundingClientRect();
    const headerBottom = el.querySelector('thead')?.getBoundingClientRect().bottom || wrapRect.top;
    for (const row of el.querySelectorAll('tbody tr.wb-grid-row')) {
      const rowRect = row.getBoundingClientRect();
      if (rowRect.bottom > headerBottom && rowRect.top < wrapRect.bottom) {
        return Number(row.querySelector('td[data-column-name="id"]')?.textContent?.trim() || 0);
      }
    }
    return 0;
  });
  let firstVisibleId = await readFirstVisibleIdNow();
  let rounds = 0;
  while (firstVisibleId > 1 && rounds < 60) {
    for (let i = 0; i < 40; i += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(12);
    }
    rounds += 1;
    firstVisibleId = await readFirstVisibleIdNow();
  }
  await page.waitForTimeout(600);

  const timeline = await page.evaluate(() => {
    window.__stopRecorder?.();
    return window.__scrollTimeline || [];
  });
  console.log(`latency=${latencyMs}ms frames=${timeline.length}`);

  let heightChanges = 0;
  let scrollReversals = 0;
  let rowReversals = 0;
  for (let i = 1; i < timeline.length; i += 1) {
    const prev = timeline[i - 1];
    const now = timeline[i];
    if (Math.abs(prev.scrollHeight - now.scrollHeight) > 1) {
      heightChanges += 1;
      console.error(
        `HEIGHT-CHANGE frame#${i} t=${now.t.toFixed(0)}ms: scrollHeight ${prev.scrollHeight} -> ${now.scrollHeight}, `
        + `firstId ${prev.firstId} -> ${now.firstId}, scrollTop ${prev.scrollTop} -> ${now.scrollTop}`,
      );
    }
    if (now.scrollTop - prev.scrollTop > 1) {
      scrollReversals += 1;
      console.error(
        `SCROLL-REVERSAL frame#${i} t=${now.t.toFixed(0)}ms: `
        + `scrollTop ${prev.scrollTop} -> ${now.scrollTop}, firstId ${prev.firstId} -> ${now.firstId}`,
      );
    }
    if (prev.firstId > 0 && now.firstId - prev.firstId > 2) {
      rowReversals += 1;
      console.error(
        `ROW-REVERSAL frame#${i} t=${now.t.toFixed(0)}ms: `
        + `firstId ${prev.firstId} -> ${now.firstId}, scrollTop ${prev.scrollTop} -> ${now.scrollTop}`,
      );
    }
  }
  if (heightChanges > 0) fail(`scroll height changed ${heightChanges} time(s) during reverse paging`);
  if (scrollReversals > 0) fail(`scrollTop moved against the wheel gesture ${scrollReversals} time(s)`);
  if (rowReversals > 0) fail(`visible rows moved against the wheel gesture ${rowReversals} time(s)`);

  const last = timeline[timeline.length - 1] || {};
  console.log('final frame:', JSON.stringify(last), `rounds=${rounds}`);
  if (last.firstId !== 1) fail(`sustained wheel-up should reach the first row, got firstId=${last.firstId}`);
  console.log('sustained wheel-up: fixed height, monotonic motion, reaches row 1: ok');
  console.log('DONE');
} catch (error) {
  fail(error?.message || String(error));
} finally {
  await browser.close();
}
