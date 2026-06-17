import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
try {
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const items = await page.locator('.wb-tree-row').evaluateAll(rows => rows.map(r => ({
    text: r.textContent.trim().replace(/\s+/g,' '),
    depth: r.closest('.wb-tree-node')?.querySelector('.wb-tree-node') ? 'has-children' : 'leaf',
    classes: r.className,
  })));
  console.log(JSON.stringify(items.slice(0,30), null, 2));
} finally { await browser.close(); }
