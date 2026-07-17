import { chromium } from 'playwright';

const snapshot = {
  version: 4,
  connectionId: 'demo',
  database: 'game_db',
  tabs: [
    { id: 'tab-1', kind: 'data', connectionId: 'demo', database: 'game_db', tableName: 'player', tableComment: '' },
    { id: 'tab-2', kind: 'design', connectionId: 'demo', database: 'game_db', tableName: 'hero', tableComment: '' },
    { id: 'tab-3', kind: 'sql', connectionId: 'demo', database: 'game_db', title: '每日统计查询', sql: 'select 1', dirty: true },
    { id: 'tab-4', kind: 'data', connectionId: 'demo', database: '', tableName: 'legacy_no_db', tableComment: '' },
  ],
  activeTabId: 'tab-1',
  panes: { 'pane-1': { id: 'pane-1', tabIds: ['tab-1', 'tab-2', 'tab-3', 'tab-4'], activeTabId: 'tab-1' } },
  layout: { type: 'pane', paneId: 'pane-1' },
  focusedPaneId: 'pane-1',
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
await page.addInitScript((snap) => localStorage.setItem('dbscout_workspace', JSON.stringify(snap)), snapshot);
await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
await page.screenshot({ path: 'output/tabbar-mixed-kinds.png' });
console.log(await page.evaluate(() =>
  [...document.querySelectorAll('.wb-tab')].map((t) => `${t.dataset.kind}:${t.querySelector('.wb-tab-title')?.className}`).join('\n'),
));
await browser.close();
