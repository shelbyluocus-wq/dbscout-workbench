import { chromium } from 'playwright';

const TABLES = ['player', 'hero', 'item', 'equip', 'skill', 'quest', 'stage', 'monster'];

function snapshotFor(tableNames) {
  const tabs = tableNames.map((tableName, i) => ({
    id: `tab-${i + 1}`,
    kind: 'data',
    connectionId: 'demo',
    database: 'game_db',
    tableName,
    tableComment: '',
  }));
  return {
    version: 4,
    connectionId: 'demo',
    database: 'game_db',
    tabs,
    activeTabId: 'tab-1',
    panes: { 'pane-1': { id: 'pane-1', tabIds: tabs.map((t) => t.id), activeTabId: 'tab-1' } },
    layout: { type: 'pane', paneId: 'pane-1' },
    focusedPaneId: 'pane-1',
  };
}

const browser = await chromium.launch({ headless: true });

async function shoot({ name, tables, width, dark }) {
  const page = await browser.newPage({ viewport: { width, height: 820 } });
  try {
    await page.addInitScript(([snap, isDark]) => {
      localStorage.setItem('dbscout_workspace', JSON.stringify(snap));
      if (isDark) localStorage.setItem('dbscout_theme', 'dark');
    }, [snapshotFor(tables), dark]);
    await page.goto('http://127.0.0.1:1431/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);
    const info = await page.evaluate(() => {
      const quickOpen = document.querySelector('.wb-quick-open-entry')?.getBoundingClientRect();
      const tabs = [...document.querySelectorAll('.wb-tab')];
      const lastTab = tabs[tabs.length - 1]?.getBoundingClientRect();
      const firstDataTab = document.querySelector('.wb-tab[data-kind="data"]');
      const subtitle = firstDataTab?.querySelector('.wb-tab-line-secondary');
      const subtitleBox = subtitle?.getBoundingClientRect();
      return {
        tabCount: tabs.length,
        firstTabWidth: Math.round(firstDataTab?.getBoundingClientRect().width || 0),
        subtitleVisible: subtitleBox ? subtitleBox.height > 0 : false,
        subtitleText: subtitle?.textContent?.trim(),
        overlap: lastTab && quickOpen ? Math.round(lastTab.right - quickOpen.left) : null,
      };
    });
    console.log(name, JSON.stringify(info));
    await page.screenshot({ path: `output/${name}.png` });
  } finally {
    await page.close();
  }
}

await shoot({ name: 'tabbar-redesign-wide', tables: TABLES.slice(0, 4), width: 1280, dark: false });
await shoot({ name: 'tabbar-redesign-crowded', tables: TABLES, width: 1280, dark: false });
await shoot({ name: 'tabbar-redesign-dark', tables: TABLES.slice(0, 5), width: 1280, dark: true });
await browser.close();
console.log('done');
