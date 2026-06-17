import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
try {
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  for (const name of ['player', 'hero', 'item']) {
    const row = page.locator('.wb-tree-row.wb-table-item').filter({ hasText: new RegExp(`^${name}`) }).first();
    if (await row.count()) {
      await row.dblclick();
      await page.waitForTimeout(600);
    }
  }
  await page.screenshot({ path: 'output/tabbar-open3-light.png' });
  console.log('light screenshot saved');

  // toggle theme
  const btns = await page.locator('button').all();
  for (const btn of btns) {
    const title = await btn.getAttribute('title');
    if (title && title.includes('主题')) {
      await btn.click();
      await page.waitForTimeout(500);
      break;
    }
  }
  await page.screenshot({ path: 'output/tabbar-open3-dark.png' });
  console.log('dark screenshot saved');
} finally { await browser.close(); }
