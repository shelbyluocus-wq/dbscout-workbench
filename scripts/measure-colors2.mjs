import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
try {
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.locator('.wb-sidebar-settings-trigger').click();
  await page.waitForTimeout(300);
  await page.locator('.wb-sidebar-theme-segment button').filter({ hasText: '深色' }).click();
  await page.waitForTimeout(500);
  for (const name of ['player', 'hero', 'item']) {
    const row = page.locator('.wb-tree-row.wb-table-item').filter({ hasText: new RegExp(`^${name}`) }).first();
    if (await row.count()) { await row.dblclick(); await page.waitForTimeout(600); }
  }
  const styles = await page.evaluate(() => {
    const rgb = (el) => getComputedStyle(el).backgroundColor;
    return {
      titlebar: rgb(document.querySelector('.wb-titlebar')),
      titlebarTabs: rgb(document.querySelector('.wb-titlebar-tabs')),
      titlebarSidebar: rgb(document.querySelector('.wb-titlebar-sidebar')),
      titlebarInspector: rgb(document.querySelector('.wb-titlebar-inspector-controls')),
      paneTabbar: rgb(document.querySelector('.wb-pane-tabbar')),
      tabInactive: rgb(document.querySelector('.wb-tab:not(.active)')),
      tabActive: rgb(document.querySelector('.wb-tab.active')),
      toolbar: rgb(document.querySelector('.wb-table-toolbar')),
      gridHeader: rgb(document.querySelector('.wb-grid-header-row, .wb-grid-header, [class*="grid-header"]')),
    };
  });
  console.log(JSON.stringify(styles, null, 2));
} finally { await browser.close(); }
