import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
try {
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // open a few tables
  const rows = await page.locator('.wb-tree-row').all();
  for (const row of rows.slice(0, 3)) {
    await row.dblclick();
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: 'output/tabbar-open-light.png' });
  console.log('light screenshot saved');

  // switch to dark theme via window.__tauri* fallback? Use localStorage or theme toggle
  const themeBtn = page.locator('button[title="切换主题"], button[aria-label="切换主题"]').first();
  if (await themeBtn.count() > 0) {
    await themeBtn.click();
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: 'output/tabbar-open-dark.png' });
  console.log('dark screenshot saved');
} finally {
  await browser.close();
}
