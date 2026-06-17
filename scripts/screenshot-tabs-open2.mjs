import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
try {
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // expand Demo GameDB -> game_db
  const demo = page.locator('.wb-tree-row').filter({ hasText: /Demo GameDB/ }).first();
  if (await demo.count()) await demo.locator('.wb-tree-chevron').first().click();
  await page.waitForTimeout(200);
  const gameDb = page.locator('.wb-tree-row').filter({ hasText: /^game_db$/ }).first();
  if (await gameDb.count()) await gameDb.locator('.wb-tree-chevron').first().click();
  await page.waitForTimeout(500);
  // open first few tables by title
  for (const name of ['player', 'hero', 'item']) {
    const row = page.locator('.wb-tree-row').filter({ hasText: new RegExp(`^${name}\s`) }).first();
    if (await row.count()) {
      await row.dblclick();
      await page.waitForTimeout(600);
    }
  }
  await page.screenshot({ path: 'output/tabbar-open2-light.png' });
  console.log('light screenshot saved');

  // find theme toggle
  const btns = await page.locator('button').all();
  for (const btn of btns) {
    const title = await btn.getAttribute('title');
    if (title && title.includes('主题')) {
      await btn.click();
      await page.waitForTimeout(500);
      break;
    }
  }
  await page.screenshot({ path: 'output/tabbar-open2-dark.png' });
  console.log('dark screenshot saved');
} finally {
  await browser.close();
}
