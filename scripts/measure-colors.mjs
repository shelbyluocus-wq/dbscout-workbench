import { chromium } from 'playwright';
import { getColorSync } from 'colorthief';
import { createCanvas, loadImage } from 'canvas';

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
  await page.screenshot({ path: 'output/tabbar-dark-before.png' });
  
  // Use canvas to sample colors at specific points
  const img = await loadImage('output/tabbar-dark-before.png');
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const points = [
    { name: 'titlebar-left', x: 80, y: 16 },
    { name: 'titlebar-center', x: 500, y: 16 },
    { name: 'titlebar-right', x: 1100, y: 16 },
    { name: 'tabbar-bg', x: 500, y: 50 },
    { name: 'tab-inactive', x: 560, y: 50 },
    { name: 'toolbar', x: 500, y: 80 },
    { name: 'grid-header', x: 500, y: 110 },
  ];
  for (const p of points) {
    const [r,g,b] = ctx.getImageData(p.x, p.y, 1, 1).data;
    console.log(`${p.name}: rgb(${r},${g},${b}) at (${p.x},${p.y})`);
  }
} finally { await browser.close(); }
