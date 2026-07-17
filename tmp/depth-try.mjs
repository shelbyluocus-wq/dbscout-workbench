import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'output/impeccable/depth';
mkdirSync(OUT, { recursive: true });

const LIGHT = `
--wb-window:#e5e8eb;
--wb-chrome-surface:#eff1f4;
--wb-tree-surface:rgba(226,230,235,0.72);
--wb-pane-header:rgba(244,246,248,0.75);
--wb-workspace-mist:oklch(90.5% 0.006 255);
--wb-workspace-mist-raised:oklch(95.5% 0.004 255);
--wb-workspace-mist-canvas:oklch(91.5% 0.005 255);
--wb-grid-header:oklch(90.8% 0.007 255);
--wb-grid-row:oklch(98.6% 0.002 255);
--wb-grid-row-alt:oklch(95.4% 0.004 255);
--wb-grid-canvas:rgba(252,253,254,0.95);
--wb-index-surface:oklch(91.8% 0.006 255);
--wb-toolbar-surface:rgba(247,248,250,0.85);
--wb-table-surface:rgba(255,255,255,0.95);
`;
const DARK = `
--wb-tree-surface:rgba(13,13,15,0.65);
--wb-pane-header:rgba(36,36,38,0.8);
--wb-grid-header:oklch(31% 0.005 255);
--wb-grid-row:oklch(28.5% 0.004 255);
--wb-grid-row-alt:oklch(26% 0.004 255);
--wb-index-surface:oklch(29.5% 0.005 255);
--wb-workspace-mist:oklch(23.5% 0.004 255);
--wb-workspace-mist-raised:oklch(30% 0.004 255);
--wb-workspace-mist-canvas:oklch(26% 0.004 255);
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const sleep = (ms) => page.waitForTimeout(ms);

async function ensureSidebar() {
  try {
    await page.locator('.wb-table-item').first().waitFor({ state: 'visible', timeout: 2500 });
  } catch {
    const expander = page.getByRole('button', { name: '展开数据库栏' });
    if (await expander.count()) { await expander.first().click(); await sleep(600); }
  }
}
async function openPlayer() {
  await page.locator('.wb-table-item', { hasText: 'player' }).first().dblclick();
  await page.locator('tr.wb-grid-row').first().waitFor({ state: 'visible', timeout: 8000 });
  await sleep(600);
}
async function inject(css) {
  await page.evaluate((t) => {
    let tag = document.getElementById('depth-override');
    if (!tag) {
      tag = document.createElement('style');
      tag.id = 'depth-override';
      document.head.appendChild(tag);
    }
    tag.textContent = `:root{${t}}`;
  }, css);
}

try {
  await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.setItem('dbscout_theme', 'light'));
  await page.reload({ waitUntil: 'networkidle' });
  await sleep(1200);
  await ensureSidebar();
  await openPlayer();
  await page.screenshot({ path: `${OUT}/light-before.png` });
  await inject(LIGHT);
  await sleep(300);
  await page.screenshot({ path: `${OUT}/light-after.png` });

  await page.evaluate(() => localStorage.setItem('dbscout_theme', 'dark'));
  await page.reload({ waitUntil: 'networkidle' });
  await sleep(1200);
  await ensureSidebar();
  await openPlayer();
  await page.screenshot({ path: `${OUT}/dark-before.png` });
  await inject(DARK);
  await sleep(300);
  await page.screenshot({ path: `${OUT}/dark-after.png` });
  console.log('done');
} finally {
  await browser.close();
}
