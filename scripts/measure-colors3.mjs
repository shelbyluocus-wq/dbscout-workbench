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
    const rgb = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).backgroundColor : null;
    };
    return {
      titlebar: rgb('.wb-titlebar'),
      titlebarTabs: rgb('.wb-titlebar-tabs'),
      titlebarSidebar: rgb('.wb-titlebar-sidebar'),
      titlebarInspector: rgb('.wb-titlebar-inspector-controls'),
      paneTabbar: rgb('.wb-pane-tabbar'),
      tabInactive: rgb('.wb-tab:not(.active)'),
      tabActive: rgb('.wb-tab.active'),
      toolbar: rgb('.wb-table-toolbar'),
      gridHeader: rgb('.wb-grid-header-row'),
    };
  });
  console.log(JSON.stringify(styles, null, 2));
} finally { await browser.close(); }
