import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
try {
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // open settings and switch to dark
  await page.locator('.wb-sidebar-settings-trigger').click();
  await page.waitForTimeout(300);
  await page.locator('.wb-sidebar-theme-segment button').filter({ hasText: '深色' }).click();
  await page.waitForTimeout(500);
  // open tables
  for (const name of ['player', 'hero', 'item']) {
    const row = page.locator('.wb-tree-row.wb-table-item').filter({ hasText: new RegExp(`^${name}`) }).first();
    if (await row.count()) {
      await row.dblclick();
      await page.waitForTimeout(600);
    }
  }
  await page.screenshot({ path: 'output/tabbar-dark-before.png' });
  console.log('dark screenshot saved');
} finally { await browser.close(); }
