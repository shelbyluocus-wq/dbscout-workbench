// 回归冒烟：在模拟后端时延下持续滚轮滚动。
// 先从首页向下跨过首批数据，再跳到末行持续向上回到表顶；两段都断言
// 滚动总高度固定、滚动坐标和可见行不反向跳、加载过程中不出现空白。
// 用法: node scripts/smoke-boundary-wheel-hold.mjs [latencyMs]
import { chromium } from 'playwright';

const latencyMs = Number(process.argv[2] || 300);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
await page.addInitScript((ms) => { window.__DBSCOUT_MOCK_PAGE_LATENCY_MS__ = ms; }, latencyMs);

const grid = () => page.locator('.wb-grid-wrap').first();

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

async function startRecorder() {
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
}

async function stopRecorder() {
  return page.evaluate(() => {
    window.__stopRecorder?.();
    return window.__scrollTimeline || [];
  });
}

async function wheelUntil({ deltaY, reached, maxRounds }) {
  await grid().hover();
  let firstVisibleId = await readFirstVisibleIdNow();
  let rounds = 0;
  while (!reached(firstVisibleId) && rounds < maxRounds) {
    for (let i = 0; i < 40; i += 1) {
      await page.mouse.wheel(0, deltaY);
      await page.waitForTimeout(12);
    }
    rounds += 1;
    firstVisibleId = await readFirstVisibleIdNow();
  }
  await page.waitForTimeout(600);
  return { firstVisibleId: await readFirstVisibleIdNow(), rounds };
}

function assertStableTimeline(timeline, { direction, label }) {
  let heightChanges = 0;
  let scrollReversals = 0;
  let rowReversals = 0;
  let blankFrames = 0;
  for (let i = 1; i < timeline.length; i += 1) {
    const prev = timeline[i - 1];
    const now = timeline[i];
    if (Math.abs(prev.scrollHeight - now.scrollHeight) > 1) {
      heightChanges += 1;
      if (heightChanges <= 3) {
        console.error(
          `HEIGHT-CHANGE ${label} frame#${i}: scrollHeight ${prev.scrollHeight} -> ${now.scrollHeight}, `
          + `firstId ${prev.firstId} -> ${now.firstId}, scrollTop ${prev.scrollTop} -> ${now.scrollTop}`,
        );
      }
    }
    const scrollMovedBackward = direction === 'down'
      ? prev.scrollTop - now.scrollTop > 1
      : now.scrollTop - prev.scrollTop > 1;
    if (scrollMovedBackward) {
      scrollReversals += 1;
      if (scrollReversals <= 3) {
        console.error(
          `SCROLL-REVERSAL ${label} frame#${i}: `
          + `scrollTop ${prev.scrollTop} -> ${now.scrollTop}, firstId ${prev.firstId} -> ${now.firstId}`,
        );
      }
    }
    const rowMovedBackward = prev.firstId > 0
      && now.firstId > 0
      && (direction === 'down'
        ? prev.firstId - now.firstId > 2
        : now.firstId - prev.firstId > 2);
    if (rowMovedBackward) {
      rowReversals += 1;
      if (rowReversals <= 3) {
        console.error(
          `ROW-REVERSAL ${label} frame#${i}: `
          + `firstId ${prev.firstId} -> ${now.firstId}, scrollTop ${prev.scrollTop} -> ${now.scrollTop}`,
        );
      }
    }
    if (now.firstId === 0) blankFrames += 1;
  }
  if (heightChanges > 0) fail(`${label}: scroll height changed ${heightChanges} time(s)`);
  if (scrollReversals > 0) fail(`${label}: scrollTop moved against the wheel gesture ${scrollReversals} time(s)`);
  if (rowReversals > 0) fail(`${label}: visible rows moved against the wheel gesture ${rowReversals} time(s)`);
  if (blankFrames > 0) fail(`${label}: grid was blank for ${blankFrames} frame(s)`);
  return timeline[timeline.length - 1] || {};
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

  // 首屏先显示，精确总行数随后在后台返回；确认固定长度已就绪后再开始记录。
  await page.waitForFunction(() => (
    document.querySelector('.wb-grid-wrap')?.getAttribute('aria-rowcount') === '10002'
  ), { timeout: 15000 });
  await page.waitForTimeout(latencyMs * 4 + 1200);

  await startRecorder();
  const forward = await wheelUntil({
    deltaY: 120,
    reached: (firstVisibleId) => firstVisibleId >= 1200,
    maxRounds: 20,
  });
  const forwardTimeline = await stopRecorder();
  console.log(`forward latency=${latencyMs}ms frames=${forwardTimeline.length}`);
  const forwardLast = assertStableTimeline(forwardTimeline, {
    direction: 'down',
    label: 'sustained wheel-down',
  });
  console.log('forward final frame:', JSON.stringify(forwardLast), `rounds=${forward.rounds}`);
  if (forward.firstVisibleId < 1200) {
    fail(`sustained wheel-down should load beyond row 1200, got firstId=${forward.firstVisibleId}`);
  }
  console.log('sustained wheel-down: fixed height, monotonic motion, no blank frame: ok');

  // 等待向下预取收尾，避免“末行”点击撞上 loadingMore 被 busy 吞掉。
  await page.waitForFunction(() => document.querySelector('.wb-grid-wrap')?.getAttribute('aria-busy') === 'false');
  await page.locator('.wb-grid-boundary-pill', { hasText: '末行' }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector('.wb-grid-wrap');
    if (!el) return false;
    const ids = [...el.querySelectorAll('tbody tr.wb-grid-row td[data-column-name="id"]')]
      .map((cell) => Number(cell.textContent.trim()));
    return ids.length > 0 && Math.max(...ids) === 10000;
  }, { timeout: 15000 });
  await page.waitForTimeout(300);

  await startRecorder();

  // 按住滚轮持续向上：真实鼠标连击节奏，一路滚到表顶为止（带轮次上限）。
  const reverse = await wheelUntil({
    deltaY: -120,
    reached: (firstVisibleId) => firstVisibleId === 1,
    maxRounds: 60,
  });
  const reverseTimeline = await stopRecorder();
  console.log(`reverse latency=${latencyMs}ms frames=${reverseTimeline.length}`);
  const reverseLast = assertStableTimeline(reverseTimeline, {
    direction: 'up',
    label: 'sustained wheel-up',
  });
  console.log('reverse final frame:', JSON.stringify(reverseLast), `rounds=${reverse.rounds}`);
  if (reverse.firstVisibleId !== 1) {
    fail(`sustained wheel-up should reach the first row, got firstId=${reverse.firstVisibleId}`);
  }
  console.log('sustained wheel-up: fixed height, monotonic motion, reaches row 1: ok');
  console.log('DONE');
} catch (error) {
  fail(error?.message || String(error));
} finally {
  await browser.close();
}
